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
	export const type = new RequestType<ReadFileParams, string, void, void>('lsif/readfile');
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

const databases: Map<string, Database> = new Map();
function getDatabaseKey(uri: string): string {
	return uri.charAt(uri.length - 1) !== '/' ? `${uri}/` : uri;
}

async function createDatabase(folder: WorkspaceFolder): Promise<void> {
	let uri: Uri = Uri.parse(folder.uri);
	const fsPath = uri.fsPath;
	const extName = path.extname(fsPath);
	if (fs.existsSync(fsPath)) {
		try {
			let database: Database | undefined;
			if (extName === '.db') {
				database = new SqliteDatabase(fsPath, (projectRoot: string) => {
					return new Transformer(uri, projectRoot);
				});
			} else if (extName === '.json') {
				database = new JsonDatabase(fsPath);
			}
			if (database !== undefined) {
				databases.set(getDatabaseKey(folder.uri), database);
			}
		} catch (_error) {
			// report FileNotFound when accessing.
		}
	}
}

function findDatabase(uri: string): Database | undefined {
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

connection.onInitialized(() => {
	try {
		for (let folder of workspaceFolders.values()) {
			const uri: Uri = Uri.parse(folder.uri);
			if (uri.scheme === LSIF_SCHEME) {
				createDatabase(folder);
			}
		}
	} finally {
		_sortedDatabaseKeys = undefined;
		checkRegistrations();
	}
	// handle updates.
	connection.workspace.onDidChangeWorkspaceFolders((event) => {
		for (let removed of event.removed) {
			const uri: Uri = Uri.parse(removed.uri);
			if (uri.scheme === LSIF_SCHEME) {
				const dbKey = getDatabaseKey(removed.uri);
				const database = databases.get(dbKey);
				if (database) {
					try {
						database.close();
					} finally {
						databases.delete(dbKey);
					}
				}
			}
		}
		for (let added of event.added) {
			const uri: Uri = Uri.parse(added.uri);
			if (uri.scheme === LSIF_SCHEME) {
				createDatabase(added);
			}
		}
		_sortedDatabaseKeys = undefined;
		checkRegistrations();
	});
});

connection.onShutdown(() => {
	try {
		for (let database of databases.values()) {
			database.close();
		}
	} finally {
		_sortedDatabaseKeys = undefined;
		databases.clear();
	}
});

connection.onRequest(StatFileRequest.type, (params) => {
	let database = findDatabase(params.uri);
	if (database === undefined) {
		return null;
	}
	return database.stat(params.uri);
});

connection.onRequest(ReadDirectoryRequest.type, (params) => {
	let database = findDatabase(params.uri);
	if (database === undefined) {
		return [];
	}
	return database.readDirectory(params.uri);
});

connection.onRequest(ReadFileRequest.type, (params) => {
	let database = findDatabase(params.uri);
	if (database === undefined) {
		return '';
	}
	return database.readFileContent(params.uri);
});

connection.onDocumentSymbol((params) => {
	let database = findDatabase(params.textDocument.uri);
	if (database === undefined) {
		return null;
	}
	return database.documentSymbols(params.textDocument.uri);
});

connection.onFoldingRanges((params) => {
	let database = findDatabase(params.textDocument.uri);
	if (database === undefined) {
		return null;
	}
	return database.foldingRanges(params.textDocument.uri);
});

connection.onDefinition((params) => {
	let database = findDatabase(params.textDocument.uri);
	if (database === undefined) {
		return null;
	}
	return database.definitions(params.textDocument.uri, params.position);
});

connection.onHover((params) => {
	let database = findDatabase(params.textDocument.uri);
	if (database === undefined) {
		return null;
	}
	return database.hover(params.textDocument.uri, params.position);
});


connection.onReferences((params) => {
	let database = findDatabase(params.textDocument.uri);
	if (database === undefined) {
		return null;
	}
	return database.references(params.textDocument.uri, params.position, params.context);
});

connection.listen();