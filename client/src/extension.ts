/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';

import { workspace, ExtensionContext, FileType as VFileType, FileSystemProvider, Uri, Event, FileChangeEvent, EventEmitter, FileSystemError, commands, window } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	Disposable,
	RequestType,
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {

	commands.registerCommand('lsif.openDatabase', () => {
		window.showOpenDialog(
			{
				openLabel: 'Select LSIF Database to open',
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				filters: { 'LSIF': ['db', 'lsif'] }
			}
		).then((values: Uri[] | undefined) => {
			if (values === undefined || values.length === 0) {
				return;
			}
			let toAdd = values.map((uri) => { return { uri: uri.with({ scheme: 'lsif'}) }; });
			workspace.updateWorkspaceFolders(
				workspace.workspaceFolders ? workspace.workspaceFolders.length : 0,
				0,
				...toAdd
			);
		});
	});

	// The server is implemented in node
	let serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'lsifServer.js')
	);
	// The debug options for the server
	// --inspect=6019: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
	let debugOptions = { execArgv: ['--nolazy', '--inspect=6029'] };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: debugOptions
		}
	};

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'lsif',
		'Language Server Index Format',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();

	let clientPromise = new Promise<LanguageClient>((resolve, reject) => {
		client.onReady().then(() => {
			resolve(client);
		}, (error) => {
			reject(error);
		});
	});

	workspace.registerFileSystemProvider('lsif', new LsifFS(clientPromise), { isCaseSensitive: true, isReadonly: true});
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

namespace FileType {
	export const Unknown: 0 = 0;
	export const File: 1 = 1;
	export const Directory: 2 = 2;
	export const SymbolicLink: 64 = 64;
}

type FileType = 0 | 1 | 2 | 64;

interface FileStat {
	type: FileType;
	ctime: number;
	mtime: number;
	size: number;
}

interface StatFileParams {
	uri: string;
}

namespace StatFileRequest {
	export const type = new RequestType<StatFileParams, FileStat | null, void>('lsif/statFile');
}

interface ReadFileParams {
	uri: string;
}

namespace ReadFileRequest {
	export const type = new RequestType<ReadFileParams, string, void>('lsif/readfile');
}

interface ReadDirectoryParams {
	uri: string;
}

namespace ReadDirectoryRequest {
	export const type = new RequestType<ReadDirectoryParams, [string, FileType][], void>('lsif/readDirectory');
}

class LsifFS implements FileSystemProvider {

	private readonly client: Promise<LanguageClient>;

	private readonly emitter: EventEmitter<FileChangeEvent[]>;
	public readonly onDidChangeFile: Event<FileChangeEvent[]>;

	public constructor(client: Promise<LanguageClient>) {
		this.client = client;
		this.emitter = new EventEmitter<FileChangeEvent[]>();
		this.onDidChangeFile = this.emitter.event;
	}

	watch(uri: Uri, options: { recursive: boolean; excludes: string[]; }): Disposable {
		// The LSIF file systrem never changes.
		return Disposable.create(():void => {});
	}

	async stat(uri: Uri): Promise<FileStat> {
		let client = await this.client;
		return client.sendRequest(StatFileRequest.type, { uri: client.code2ProtocolConverter.asUri(uri) }).then((value) => {
			if (!value) {
				throw FileSystemError.FileNotFound(uri);
			}
			return value;
		}, (error) => {
			throw FileSystemError.FileNotFound(uri);
		});
	}

	async readDirectory(uri: Uri): Promise<[string, VFileType][]> {
		let client = await this.client;
		let params: ReadDirectoryParams = { uri: client.code2ProtocolConverter.asUri(uri) };
		return client.sendRequest(ReadDirectoryRequest.type, params).then((values) => {
			return values;
		});
	}

	async readFile(uri: Uri): Promise<Uint8Array> {
		let client = await this.client;
		let params: ReadFileParams = { uri: client.code2ProtocolConverter.asUri(uri) };
		return client.sendRequest(ReadFileRequest.type, params).then((value) => {
			let result = new Uint8Array(Buffer.from(value, 'base64'));
			return result;
		});
	}

	createDirectory(uri: Uri): void | Thenable<void> {
		throw new Error('File system is readonly.');
	}

	writeFile(uri: Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): void | Thenable<void> {
		throw new Error('File system is readonly.');
	}

	delete(uri: Uri, options: { recursive: boolean; }): void | Thenable<void> {
		throw new Error('File system is readonly.');
	}

	rename(oldUri: Uri, newUri: Uri, options: { overwrite: boolean; }): void | Thenable<void> {
		throw new Error('File system is readonly.');
	}
}