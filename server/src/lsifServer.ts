/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

import { URI  } from 'vscode-uri';
import {
	createConnection, ProposedFeatures, InitializeParams, TextDocumentSyncKind, WorkspaceFolder,
	BulkUnregistration, BulkRegistration, DocumentSymbolRequest, DocumentSelector, FoldingRangeRequest,
	HoverRequest, DefinitionRequest, ReferencesRequest, RequestType, DeclarationRequest, DocumentFilter
} from 'vscode-languageserver/node';

import { Database, UriTransformer } from './database';
import { FileType, FileStat } from './files';

const LSIF_SCHEME = 'lsif';

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
	export const type = new RequestType<ReadFileParams, string | null, void>('lsif/readfile');
}

interface ReadDirectoryParams {
	uri: string;
}

namespace ReadDirectoryRequest {
	export const type = new RequestType<ReadDirectoryParams, [string, FileType][], void>('lsif/readDirectory');
}

let connection = createConnection(ProposedFeatures.all);

class Transformer implements UriTransformer {

	private lsif: string;
	private workspaceRoot: string;

	constructor(lsif: URI, workspaceRoot: string) {
		this.lsif = lsif.toString();
		this.workspaceRoot = workspaceRoot;
	}
	public toDatabase(uri: string): string {
		if (uri.startsWith(this.lsif)) {
			let p = uri.substring(this.lsif.length);
			return `${this.workspaceRoot}${p}`;
		} else {
			let parsed = URI.parse(uri);
			if (parsed.scheme === LSIF_SCHEME && parsed.query) {
				return parsed.with( { scheme: 'file', query: '' } ).toString(true);
			} else  {
				return uri;
			}
		}
	}
	public fromDatabase(uri: string): string {
		if (uri.startsWith(this.workspaceRoot)) {
			let p = uri.substring(this.workspaceRoot.length);
			return `${this.lsif}${p}`;
		} else {
			let file = URI.parse(uri);
			return file.with( { scheme: LSIF_SCHEME, query: this.lsif }).toString(true);
		}
	}
}

const workspaceFolders: Map<string, WorkspaceFolder> = new Map();
let _sortedDatabaseKeys: string[] | undefined;
function sortedDatabaseKeys(): string[] {
	if (_sortedDatabaseKeys === undefined) {
		_sortedDatabaseKeys = [];
		for (let key of databases.keys()) {
			_sortedDatabaseKeys.push(key);
		}
		_sortedDatabaseKeys.sort(
			(a, b) => {
				return a.length - b.length;
			}
		);
	}
	return _sortedDatabaseKeys;
}

const databases: Map<string, Promise<Database>> = new Map();
function getDatabaseKey(uri: string): string {
	return uri.charAt(uri.length - 1) !== '/' ? `${uri}/` : uri;
}

async function createDatabase(folder: WorkspaceFolder): Promise<Database | undefined> {
	let uri: URI = URI.parse(folder.uri);
	const fsPath = uri.fsPath;
	const extName = path.extname(fsPath);
	if (fs.existsSync(fsPath)) {
		try {
			let database: Database | undefined;
			if (extName === '.db') {
				const Sqlite = await import('better-sqlite3');
				const db = new Sqlite(fsPath, { readonly: true });
				let format = 'graph';
				try {
					format = (db.prepare('Select * from format f').get() as any).format;
				} catch (err) {
					// Old DBs have no format. Treat is as graph
				} finally {
					db.close();
				}
				if (format === 'blob') {
					const module = await import('./blobStore');
					database = new module.BlobStore();
				} else {
					const module = await import ('./graphStore');
					database = new module.GraphStore();
				}
			} else if (extName === '.lsif') {
				const module = await import('./jsonStore');
				database = new module.JsonStore();
			}
			if (database !== undefined) {
				let promise = database.load(fsPath, (workspaceRoot: string) => {
					return new Transformer(uri, workspaceRoot);
				}).then(() => {
					return database!;
				});
				databases.set(getDatabaseKey(folder.uri), promise);
				return promise;
			}
		} catch (error) {
			throw error;
		}
	}
	return Promise.reject(new Error(`Can't create database for ${folder.uri}`));
}

function findDatabase(uri: string): Promise<Database> | undefined {
	let sorted = sortedDatabaseKeys();
	let parsed = URI.parse(uri);
	if (parsed.query) {
		// The LSIF URIs are encoded.
		uri = URI.parse(parsed.query).toString();
	}
	if (uri.charAt(uri.length - 1) !== '/') {
		uri = uri + '/';
	}
	for (let element of sorted) {
		if (uri.startsWith(element)) {
			return databases.get(element);
		}
	}
	return undefined;
}

let registrations: Thenable<BulkUnregistration> | undefined;
async function checkRegistrations(): Promise<void> {
	if (databases.size === 0 && registrations !== undefined) {
		registrations.then(unregister => unregister.dispose(), error => connection.console.error('Failed to unregister listeners.'));
		registrations = undefined;
		return;
	}
	if (databases.size >= 1 && registrations === undefined) {
		let documentSelector: DocumentSelector = [
			{ scheme: 'lsif', exclusive: true } as DocumentFilter
		];
		let toRegister: BulkRegistration = BulkRegistration.create();
		toRegister.add(DocumentSymbolRequest.type, {
			documentSelector
		});
		toRegister.add(FoldingRangeRequest.type, {
			documentSelector
		});
		toRegister.add(DefinitionRequest.type, {
			documentSelector
		});
		toRegister.add(DeclarationRequest.type, {
			documentSelector
		});
		toRegister.add(HoverRequest.type, {
			documentSelector
		});
		toRegister.add(ReferencesRequest.type, {
			documentSelector
		});
		registrations = connection.client.register(toRegister);
	}
}

connection.onInitialize((params: InitializeParams) => {
	if (params.workspaceFolders) {
		for (let folder of params.workspaceFolders) {
			workspaceFolders.set(folder.uri, folder);
		}
	}
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.None,
			workspace: {
				workspaceFolders: {
					supported: true
				}
			}
		}
	};
});

connection.onInitialized(async () => {
	try {
		for (let folder of workspaceFolders.values()) {
			const uri: URI = URI.parse(folder.uri);
			if (uri.scheme === LSIF_SCHEME) {
				try {
					await createDatabase(folder);
				} catch (err: any) {
					connection.console.error(err.message);
				}
			}
		}
	} finally {
		_sortedDatabaseKeys = undefined;
		checkRegistrations();
	}
	// handle updates.
	connection.workspace.onDidChangeWorkspaceFolders(async (event) => {
		for (let removed of event.removed) {
			const uri: URI = URI.parse(removed.uri);
			if (uri.scheme === LSIF_SCHEME) {
				const dbKey = getDatabaseKey(removed.uri);
				const promise = databases.get(dbKey);
				if (promise) {
					promise.then((database) => {
						try {
							database.close();
						} finally {
							databases.delete(dbKey);
						}
					});
				}
			}
		}
		for (let added of event.added) {
			const uri: URI = URI.parse(added.uri);
			if (uri.scheme === LSIF_SCHEME) {
				await createDatabase(added);
			}
		}
		_sortedDatabaseKeys = undefined;
		checkRegistrations();
	});
});

connection.onShutdown(() => {
	try {
		for (let promise of databases.values()) {
			promise.then((database) => database.close());
		}
	} finally {
		_sortedDatabaseKeys = undefined;
		databases.clear();
	}
});

connection.onRequest(StatFileRequest.type, async (params) => {
	let promise = findDatabase(params.uri);
	if (promise === undefined) {
		return null;
	}
	let database = await promise;
	return database.stat(params.uri);
});

connection.onRequest(ReadDirectoryRequest.type, async (params) => {
	let promise = findDatabase(params.uri);
	if (promise === undefined) {
		return [];
	}
	let database = await promise;
	return database.readDirectory(params.uri);
});

connection.onRequest(ReadFileRequest.type, async (params) => {
	let promise = findDatabase(params.uri);
	if (promise === undefined) {
		return null;
	}
	let database = await promise;
	return database.readFileContent(params.uri);
});

connection.onDocumentSymbol(async (params) => {
	let promise = findDatabase(params.textDocument.uri);
	if (promise === undefined) {
		return null;
	}
	let database = await promise;
	return database.documentSymbols(params.textDocument.uri);
});

connection.onFoldingRanges(async (params) => {
	let promise = findDatabase(params.textDocument.uri);
	if (promise === undefined) {
		return null;
	}
	let database = await promise;
	return database.foldingRanges(params.textDocument.uri);
});

connection.onHover(async (params) => {
	let promise = findDatabase(params.textDocument.uri);
	if (promise === undefined) {
		return null;
	}
	let database = await promise;
	return database.hover(params.textDocument.uri, params.position);
});

connection.onDeclaration(async (params) => {
	let promise = findDatabase(params.textDocument.uri);
	if (promise === undefined) {
		return null;
	}
	let database = await promise;
	return database.declarations(params.textDocument.uri, params.position);
});

connection.onDefinition(async (params) => {
	let promise = findDatabase(params.textDocument.uri);
	if (promise === undefined) {
		return null;
	}
	let database = await promise;
	return database.definitions(params.textDocument.uri, params.position);
});

connection.onReferences(async (params) => {
	let promise = findDatabase(params.textDocument.uri);
	if (promise === undefined) {
		return null;
	}
	let database = await promise;
	return database.references(params.textDocument.uri, params.position, params.context);
});

connection.listen();