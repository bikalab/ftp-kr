
import * as ssh2 from 'ssh2';
import * as path from 'path';
import * as stream from 'stream';
import { window } from 'vscode';

import { File } from './util/file';
import { ServerConfig, FileInfo } from './util/fileinfo';

import { FileInterface } from './vsutil/fileinterface';
import { SftpConnection } from './vsutil/sftp';
import { FtpConnection } from './vsutil/ftp';
import { vsutil } from './vsutil/vsutil';
import { Logger } from './vsutil/log';
import { Workspace } from './vsutil/ws';
import { Task } from './vsutil/work';

import { Config } from './config';

function createClient(workspace:Workspace, config:ServerConfig):FileInterface
{
	var newclient:FileInterface;
	switch (config.protocol)
	{
	case 'sftp': newclient = new SftpConnection(workspace, config); break;
	case 'ftp': newclient = new FtpConnection(workspace, config); break;
	case 'ftps': newclient = new FtpConnection(workspace, config); break;
	default: throw Error(`Invalid protocol ${config.protocol}`);
	}
	return newclient;
}

export class FtpManager
{
	private client:FileInterface|null = null;
	private connectionInfo:string = '';
	private destroyTimeout:NodeJS.Timer|null = null;
	private cancelBlockedCommand:(()=>void)|null = null;
	private connected:boolean = false;
	
	private readonly logger:Logger;

	constructor(public readonly workspace:Workspace, public readonly config:ServerConfig)
	{
		this.logger = workspace.query(Logger);
	}

	private cancelDestroyTimeout():void
	{
		if (!this.destroyTimeout)
			return;

		clearTimeout(this.destroyTimeout);
		this.destroyTimeout = null;
	}

	private updateDestroyTimeout():void
	{
		this.cancelDestroyTimeout();
		this.destroyTimeout = setTimeout(()=>this.destroy(), this.config.connectionTimeout || 60000);
	}

	public destroy():void
	{
		this.cancelDestroyTimeout();
		if (this.cancelBlockedCommand)
		{
			this.cancelBlockedCommand();
			this.cancelBlockedCommand = null;
		}
		if (this.client)
		{
			if (this.connected)
			{
				this.client.log('Disconnected');
				this.connected = false;
			}
			this.client.disconnect();
			this.client = null;
		}
	}

	private makeConnectionInfo():string
	{
		const config = this.config;
		const usepk = config.protocol === 'sftp' && !!config.privateKey;
		const datas = [
			config.protocol,
			config.username,
			config.password,
			config.host,
			config.port,
			config.remotePath,
			usepk,
			usepk ? config.privateKey : undefined,
			usepk ? config.passphrase : undefined
		];
		return JSON.stringify(datas);
	}

	private blockTestWith<T>(task:Promise<T>):Promise<T>
	{
		return new Promise<T>((resolve, reject)=>{
			if (this.cancelBlockedCommand)
			{
				throw Error('Multiple order at same time');
			}
			var blockTimeout:NodeJS.Timer|null = setTimeout(()=>{
				if (blockTimeout)
				{
					this.cancelBlockedCommand = null;
					blockTimeout = null;
					reject('BLOCKED');
				}
			}, this.config.blockDetectingDuration || 8000);
			this.cancelBlockedCommand = ()=>{
				if (blockTimeout)
				{
					this.cancelBlockedCommand = null;
					clearTimeout(blockTimeout);
					blockTimeout = null;
					reject('CANCELLED');
				}
			};
			task.then(t=>{
				if (blockTimeout)
				{
					this.cancelBlockedCommand = null;
					clearTimeout(blockTimeout);
					blockTimeout = null;
					resolve(t);
				}
			}).catch(err=>{
				if (blockTimeout)
				{
					this.cancelBlockedCommand = null;
					clearTimeout(blockTimeout);
					blockTimeout = null;
					reject(err);
				}
			});
		});
	}
	
	private blockTestWrap<T>(task:Task, callback:(client:FileInterface)=>Promise<T>)
	{
		return this.init(task).then(async(client)=>{
			for (;;)
			{
				this.cancelDestroyTimeout();
				try
				{
					const t = await task.with(this.blockTestWith(callback(client)));
					this.updateDestroyTimeout();
					return t;
				}
				catch(err)
				{
					this.updateDestroyTimeout();
					if (err !== 'BLOCKED') throw err;
					this.destroy();
					client = await this.init(task);
				}
			}
		});
	}

	public async init(task:Task):Promise<FileInterface>
	{
		const that = this;
		const coninfo = this.makeConnectionInfo();
		if (this.client)
		{
			if (coninfo === this.connectionInfo)
			{
				this.updateDestroyTimeout();
				return Promise.resolve(this.client);
			}
			this.destroy();
			this.config.passwordInMemory = undefined;
		}
		this.connectionInfo = coninfo;
		
		const config = this.config;
		const usepk = config.protocol === 'sftp' && !!config.privateKey;
	
		async function tryToConnect(password:string|undefined):Promise<void>
		{
			for (;;)
			{
				const client = createClient(that.workspace, config);
				try
				{
					that.logger.message(`Try connect to ${config.url} with user ${config.username}`);
					await task.with(that.blockTestWith(client.connect(password)));
					client.log('Connected');
					that.client = client;
					return;
				}
				catch (err)
				{
					if (err !== 'BLOCKED') throw err;
					client.disconnect();
				}
			}
		}
	
		async function tryToConnectOrErrorMessage(password:string|undefined):Promise<string|undefined>
		{
			try
			{
				await tryToConnect(password);
				return undefined;
			}
			catch(err)
			{
				var error:string;
				switch (err.code)
				{
				case 530:
					error = 'Authentication failed';
					break;
				default:
					switch (err.message)
					{
					case 'Login incorrect.':
					case 'All configured authentication methods failed':
						error = 'Authentication failed';
						break;
					default:
						that.destroy();
						throw err;
					}
					break;
				}
				that.logger.message(error);
				return error;
			}
		}
	
		_ok:if (!usepk && config.password === undefined)
		{
			var errorMessage:string|undefined;
			if (this.config.passwordInMemory !== undefined)
			{
				errorMessage = await tryToConnectOrErrorMessage(this.config.passwordInMemory);
				if (errorMessage === undefined) break _ok;
			}
			else for (;;)
			{
				const promptedPassword = await window.showInputBox({
					prompt:'ftp-kr: '+(config.protocol||'').toUpperCase()+" Password Request",
					password: true,
					ignoreFocusOut: true,
					placeHolder: errorMessage
				});
				if (promptedPassword === undefined)
				{
					this.destroy();
					throw 'PASSWORD_CANCEL';
				}
				errorMessage = await tryToConnectOrErrorMessage(promptedPassword);
				if (errorMessage === undefined)
				{
					if (config.keepPasswordInMemory !== false)
					{
						this.config.passwordInMemory = promptedPassword;
					}
					break;
				}
			}
		}
		else
		{
			try
			{
				await tryToConnect(config.password);
			}
			catch (err) {
				this.destroy();
				throw err;
			}
		}
		
		if (!this.client) throw Error('Client is not created');
		this.client.oninvalidencoding = (errfiles:string[])=>{
			this.logger.errorConfirm("Invalid encoding detected. Please set fileNameEncoding correctly\n"+errfiles.join('\n'), 'Open config', 'Ignore after')
			.then((res)=>{
				switch(res)
				{
				case 'Open config': vsutil.open(this.workspace.query(Config).path); break; 
				case 'Ignore after': this.config.ignoreWrongFileEncoding = true; break;
				}
			});
		};
		this.updateDestroyTimeout();
		return this.client;
	}
	
	public rmdir(task:Task, ftppath:string):Promise<void>
	{
		return this.blockTestWrap(task, client=>client.rmdir(ftppath));
	}
	
	public remove(task:Task, ftppath:string):Promise<void>
	{
		return this.blockTestWrap(task, client=>client.delete(ftppath));
	}
	
	public mkdir(task:Task, ftppath:string):Promise<void>
	{
		return this.blockTestWrap(task, client=>client.mkdir(ftppath));
	}
	
	public upload(task:Task, ftppath:string, localpath:File):Promise<void>
	{
		return this.blockTestWrap(task, client=>client.upload(ftppath, localpath));
	}
	
	public download(task:Task, localpath:File, ftppath:string):Promise<void>
	{
		return this.blockTestWrap(task, client=>client.download(localpath, ftppath));
	}
	
	public view(task:Task, ftppath:string):Promise<string>
	{
		return this.blockTestWrap(task, client=>client.view(ftppath));
	}
	
	public list(task:Task, ftppath:string):Promise<FileInfo[]>
	{
		return this.blockTestWrap(task, client=>client.list(ftppath));
	}

	public readlink(task:Task, fileinfo:FileInfo, ftppath:string):Promise<string>
	{
		return this.blockTestWrap(task, client=>client.readlink(fileinfo, ftppath));
	}
}
