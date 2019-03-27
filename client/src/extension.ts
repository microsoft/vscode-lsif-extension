/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';

import { workspace, ExtensionContext, FileStat, FileType as VFileType, FileSystemProvider, Uri, Event, FileChangeEvent, EventEmitter, FileSystemError } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	DocumentSelector,
	DocumentFilter,
	Disposable,
	RequestType,
} from 'vscode-languageclient';

let client: LanguageClient;

class UriConverter {

	private lsif: string | undefined;
	private projectRoot: string | undefined;

	public initialize(lsif: Uri, projectRoot: Uri): void {
		this.lsif = lsif.toString();
		this.projectRoot = projectRoot.toString(true);
	}

	public code2Protocol(value: Uri): string {
		if (this.lsif === undefined || this.projectRoot === undefined) {
			return value.toString();
		}
		let str = value.toString();
		if (str.startsWith(this.lsif)) {
			let p = str.substring(this.lsif.length);
			return `${this.projectRoot}${p}`;
		} else {
			return str;
		}
	}

	public protocol2Code(value: string): Uri {
		if (this.lsif === undefined || this.projectRoot === undefined) {
			return Uri.parse(value);
		}
		if (value.startsWith(this.projectRoot)) {
			let p = value.substring(this.projectRoot.length);
			return Uri.parse(`${this.lsif}${p}`);
		} else {
			return Uri.parse(value);
		}
	}

	public lsif2Fs(value: Uri): Uri {
		if (this.lsif === undefined) {
			return value;
		}
		let str = value.toString();
		return Uri.file(str.substring(this.lsif.length));
	}
}

const uriConverter: UriConverter = new UriConverter();

export function activate(context: ExtensionContext) {

	// The server is implemented in node
	let serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'lsifServer.js')
	);
	// The debug options for the server
	// --inspect=6019: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
	let debugOptions = { execArgv: ['--nolazy', '--inspect=6019'] };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc, runtime: 'node' },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: debugOptions,
			runtime: 'node'
		}
	};

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		uriConverters: {
			code2Protocol: (value) => uriConverter.code2Protocol(value),
			protocol2Code: (value) => uriConverter.protocol2Code(value)
		}
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

	client.onReady().then(() => {
		workspace.registerFileSystemProvider('lsif', new LsifFS(client), { isCaseSensitive: false, isReadonly: true});
	});
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

class File implements FileStat {

	type: VFileType;
	ctime: number;
	mtime: number;
	size: number;

	name: string;
	data: Uint8Array | undefined;

	constructor(name: string) {
		this.type = VFileType.File;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
		this.data = undefined;
	}
}

export class Directory implements FileStat {

	type: VFileType;
	ctime: number;
	mtime: number;
	size: number;

	name: string;
	entries: Map<string, File | Directory>;
	isPopulated: boolean;

	constructor(name: string) {
		this.type = VFileType.Directory;
		this.ctime = Date.now();
		this.mtime = Date.now();
		this.size = 0;
		this.name = name;
		this.entries = new Map();
		this.isPopulated = false;
	}
}

type Entry = File | Directory;

namespace FileType {
	export const Unknown: 0 = 0;
	export const File: 1 = 1;
	export const Directory: 2 = 2;
	export const SymbolicLink: 64 = 64;
}

type FileType = 0 | 1 | 2 | 64;

interface ReadFileParams {
	database: string;
	uri: string;
}

namespace ReadFileRequest {
	export const type = new RequestType<ReadFileParams, string, void, void>('lsif/readfile');
}

interface ReadDirectoryParams {
	database: string;
	uri: string;
}

namespace ReadDirectoryRequest {
	export const type = new RequestType<ReadDirectoryParams, [string, FileType][], void, void>('lsif/readDirectory');
}

interface LoadDatabaseParams {
	uri: string;
}

interface LoadDatabaseResult {
	projectRoot: string;
}

namespace LoadDatabase {
	export const type = new RequestType<LoadDatabaseParams, LoadDatabaseResult, void, void>('lisf/loadDatabase');
}

class LsifFS implements FileSystemProvider {

	private readonly client: LanguageClient;

	private dbReady: Promise<void> | undefined;
	private _projectRoot: Uri | undefined;
	private _lsifRoot: Uri | undefined;

	private rootUri: Uri;
	private readonly root: Directory;

	private readonly emitter: EventEmitter<FileChangeEvent[]>;
	public readonly onDidChangeFile: Event<FileChangeEvent[]>;

	public constructor(client: LanguageClient) {
		this.client = client;
		this.root = new Directory('');
		this.rootUri = Uri.parse('file:///');
		this.emitter = new EventEmitter<FileChangeEvent[]>();
		this.onDidChangeFile = this.emitter.event;
	}

	public get lsifRoot(): Uri {
		if (!this._lsifRoot) {
			throw new Error(`LSIF root not initialized`);
		}
		return this._lsifRoot;
	}

	public get projectRoot(): Uri {
		if (!this._projectRoot) {
			throw new Error(`Project root not initialized`);
		}
		return this._projectRoot;
	}

	watch(uri: Uri, options: { recursive: boolean; excludes: string[]; }): Disposable {
		// The LSIF file systrem never changes.
		return Disposable.create(():void => {});
	}

	async stat(uri: Uri): Promise<FileStat> {
		if (this.dbReady === undefined) {
			let readyResolve: () => void;
			let readyReject: (reason?: any) => void;
			this.dbReady = new Promise((r, e) => {
				readyResolve = r;
				readyReject = e;
			});
			this._lsifRoot = uri;
			return this.client.sendRequest(LoadDatabase.type, { uri: Uri.file(uri.fsPath).toString() }).then((value) => {
				this._projectRoot = Uri.parse(value.projectRoot)
				uriConverter.initialize(this.lsifRoot, this.projectRoot);
				readyResolve();
				return this.root;
			}, (error) => {
				readyReject(error);
				throw error;
			});
		} else {
			await this.dbReady;
			let result = this._lookup(uriConverter.lsif2Fs(uri));
			if (result === undefined) {
				throw FileSystemError.FileNotFound(uri);
			}
			return result;
		}
	}

	async readDirectory(uri: Uri): Promise<[string, VFileType][]> {
		await this.dbReady;
		const directory = this._lookupAsDirectory(uriConverter.lsif2Fs(uri));
		if (directory === undefined) {
			throw FileSystemError.FileNotFound(uri);
		}
		if (!directory.isPopulated) {
			let converted = uriConverter.code2Protocol(uri);
			let params: ReadDirectoryParams = { database: Uri.file(this.lsifRoot.fsPath).toString(), uri: converted };
			return client.sendRequest(ReadDirectoryRequest.type, params).then((values) => {
				for (let elem of values) {
					let child: Entry = elem[1] === VFileType.Directory ? new Directory(elem[0]) : new File(elem[0]);
					directory.entries.set(elem[0], child);
				}
				directory.isPopulated = true;
				return values;
			});
		} else {
			let result: [string, VFileType][] = [];
			for (let entry of directory.entries.values()) {
				result.push([entry.name, entry.type]);
			}
			return result;
		}
	}

	async readFile(uri: Uri): Promise<Uint8Array> {
		await this.dbReady;
		const file = this._lookupAsFile(uriConverter.lsif2Fs(uri));
		if (file !== undefined && file.data !== undefined) {
			return file.data;
		}
		let converted = uriConverter.code2Protocol(uri);
		let params: ReadFileParams = { database: Uri.file(this.lsifRoot.fsPath).toString(), uri: converted };
		return this.client.sendRequest(ReadFileRequest.type, params).then((value) => {
			let result = new Uint8Array(Buffer.from(value, 'base64'));
			if (file !== undefined) {
				file.data = result;
			}
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

	private _lookup(uri: Uri): Entry | undefined {
		let parts = uri.path.split('/');
		let entry: Entry = this.root;
		for (const part of parts) {
			if (!part) {
				continue;
			}
			let child: Entry | undefined;
			if (entry instanceof Directory) {
				child = entry.entries.get(part);
			}
			if (!child) {
				return undefined;
			}
			entry = child;
		}
		return entry;
	}

	private _lookupAsDirectory(uri: Uri): Directory | undefined {
		let entry = this._lookup(uri);
		if (entry instanceof Directory) {
			return entry;
		}
		return undefined;
	}

	private _lookupAsFile(uri: Uri): File | undefined {
		let entry = this._lookup(uri);
		if (entry instanceof File) {
			return entry;
		}
		throw undefined;
	}
}