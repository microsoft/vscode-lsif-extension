/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const exists = promisify(fs.exists);

import URI from 'vscode-uri';
import { createConnection, ProposedFeatures, InitializeParams, TextDocumentSyncKind, WorkspaceFolder, ServerCapabilities, TextDocument, TextDocumentPositionParams, TextDocumentIdentifier, BulkUnregistration, BulkRegistration, DocumentSymbolRequest, DocumentSelector, FoldingRangeRequest, HoverRequest, DefinitionRequest, ReferencesRequest, RequestType } from 'vscode-languageserver';

import { Database } from './database';
import { JsonDatabase } from './json';
import { SqliteDatabase } from './sqlite';
import { FileType } from './files';

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


let databases: Map<string, Database> = new Map();

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

function getDatabaseKey(uri: string): string {
	return uri.charAt(uri.length - 1) !== '/' ? `${uri}/` : uri;
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

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);
connection.onInitialize((params: InitializeParams) => {
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.None,
			workspace: {
				workspaceFolders: {
					supported: true,
					changeNotifications: true
				}
			}
		}
	};
});

connection.onRequest(LoadDatabase.type, async (params) => {
	const uri: URI = URI.parse(params.uri);
	const fsPath = uri.fsPath;
	const extName = path.extname(fsPath);
	let database: Database | undefined;
	if (extName === '.db') {
		database = new SqliteDatabase(fsPath);
	} else if (extName === '.json') {
		database = new JsonDatabase(fsPath);
	}
	if (database === undefined) {
		throw new Error(`No database found for ${fsPath}`);
	}
	database.load();
	let projectRoot = database.getProjectRoot();
	databases.set(getDatabaseKey(projectRoot), database);
	await checkRegistrations();
	return {
		projectRoot: database.getProjectRoot()
	};
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