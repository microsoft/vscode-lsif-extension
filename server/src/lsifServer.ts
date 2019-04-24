/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

import Uri from 'vscode-uri';
import { createConnection, ProposedFeatures, InitializeParams, TextDocumentSyncKind, WorkspaceFolder, ServerCapabilities, TextDocument, TextDocumentPositionParams, TextDocumentIdentifier, BulkUnregistration, BulkRegistration, DocumentSymbolRequest, DocumentSelector, FoldingRangeRequest, HoverRequest, DefinitionRequest, ReferencesRequest, RequestType } from 'vscode-languageserver';

import { Database, UriTransformer } from './database';
import { JsonDatabase } from './json';
import { SqliteDatabase } from './sqlite';
import { FileType, FileStat } from './files';

const LSIF_SCHEME = 'lsif';

interface StatFileParams {
	uri: string;
}

namespace StatFileRequest {
	export const type = new RequestType<StatFileParams, FileStat | null, void, void>('lsif/statFile');
}

interface ReadFileParams {
	uri: string;
}

namespace ReadFileRequest {
	export const type = new RequestType<ReadFileParams, string | null, void, void>('lsif/readfile');
}

interface ReadDirectoryParams {
	uri: string;
}

namespace ReadDirectoryRequest {
	export const type = new RequestType<ReadDirectoryParams, [string, FileType][], void, void>('lsif/readDirectory');
}let connection = createConnection(ProposedFeatures.all);

class Transformer implements UriTransformer {

	private lsif: string;
	private projectRoot: string;

	constructor(lsif: Uri, projectRoot: string) {
		this.lsif = lsif.toString();
		this.projectRoot = projectRoot;
	}
	public toDatabase(uri: string): string {
		if (uri.startsWith(this.lsif)) {
			let p = uri.substring(this.lsif.length);
			return `${this.projectRoot}${p}`;
		} else {
			return uri;
		}
	}
	public fromDatabase(uri: string): string {
		if (uri.startsWith(this.projectRoot)) {
			let p = uri.substring(this.projectRoot.length);
			return `${this.lsif}${p}`;
		} else {
			return uri;
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
	let uri: Uri = Uri.parse(folder.uri);
	const fsPath = uri.fsPath;
	const extName = path.extname(fsPath);
	if (fs.existsSync(fsPath)) {
		try {
			let database: Database | undefined;
			if (extName === '.db') {
				database = new SqliteDatabase();
			} else if (extName === '.lsif') {
				database = new JsonDatabase();
			}
			if (database !== undefined) {
				let promise = database.load(fsPath, (projectRoot: string) => {
					return new Transformer(uri, projectRoot);
				}).then(() => {
					return database!;
				});
				databases.set(getDatabaseKey(folder.uri), promise);
				return promise;
			}
		} catch (_error) {
			// report FileNotFound when accessing.
		}
	}
	return Promise.reject(new Error(`Can't create database for ${folder.uri}`));
}

function findDatabase(uri: string): Promise<Database> | undefined {
	let sorted = sortedDatabaseKeys();
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
			{ scheme: 'lsif', }
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
			const uri: Uri = Uri.parse(folder.uri);
			if (uri.scheme === LSIF_SCHEME) {
				try {
					await createDatabase(folder);
				} catch (err) {
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
			const uri: Uri = Uri.parse(removed.uri);
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
			const uri: Uri = Uri.parse(added.uri);
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

connection.onDefinition(async (params) => {
	let promise = findDatabase(params.textDocument.uri);
	if (promise === undefined) {
		return null;
	}
	let database = await promise;
	return database.definitions(params.textDocument.uri, params.position);
});

connection.onHover(async (params) => {
	let promise = findDatabase(params.textDocument.uri);
	if (promise === undefined) {
		return null;
	}
	let database = await promise;
	return database.hover(params.textDocument.uri, params.position);
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