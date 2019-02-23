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
import { createConnection, ProposedFeatures, InitializeParams, TextDocumentSyncKind, WorkspaceFolder, TextDocumentIdentifier, BulkUnregistration, BulkRegistration, DocumentSymbolRequest, DocumentSelector, FoldingRangeRequest, HoverRequest, DefinitionRequest, ReferencesRequest } from 'vscode-languageserver';

import { LsifDatabase } from './lsifDatabase';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);
let databases: Map<string, LsifDatabase> = new Map();
let folders: WorkspaceFolder[] | null;

connection.onInitialize((params: InitializeParams) => {

	folders = params.workspaceFolders;
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			workspace: {
				workspaceFolders: {
					supported: true,
					changeNotifications: true
				}
			}
		}
	};
});

connection.onInitialized(() => {
	connection.workspace.onDidChangeWorkspaceFolders((event) => {
		for (let folder of event.removed) {
			workspaceFolderRemoved(folder);
		}
		for (let folder of event.added) {
			workspaceFolderAdded(folder);
		}
	});
	if (folders) {
		for (let folder of folders) {
			workspaceFolderAdded(folder);
		}
	}
});

let _sortedWorkspaceFolders: string[] | undefined;
function sortedWorkspaceFolders(): string[] {
	if (_sortedWorkspaceFolders === void 0) {
		_sortedWorkspaceFolders = [];
		for (let folder of databases.keys()) {
			_sortedWorkspaceFolders.push(folder);
		}
		_sortedWorkspaceFolders.sort(
			(a, b) => {
				return a.length - b.length;
			}
		);
	}
	return _sortedWorkspaceFolders;
}

function findDatabase(uri: string): LsifDatabase | undefined {
	let sorted = sortedWorkspaceFolders();
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

function getDatabaseKey(uri: string): string {
	if (uri.charAt(uri.length - 1) !== '/') {
		uri = uri + '/';
	}
	return uri;
}

async function workspaceFolderAdded(folder: WorkspaceFolder): Promise<void> {
	let uri = URI.parse(folder.uri);
	if (uri.scheme !== 'file') {
		return;
	}
	let file = path.join(URI.parse(folder.uri).fsPath, 'lsif.json');
	if (await exists(file)) {
		try {
			let database = new LsifDatabase(file);
			database.load();
			databases.set(getDatabaseKey(uri.toString(true)), database);
			_sortedWorkspaceFolders = undefined;
			checkRegistrations();
		} catch (err) {
			const error = err as Error;
			connection.console.error(`${error.message}\n${error.stack}`)
		}
	}
}

function workspaceFolderRemoved(folder: WorkspaceFolder): void {
	let uri = URI.parse(folder.uri);
	if (uri.scheme !== 'file:') {
		return;
	}
	// Remove the data base.
	databases.delete(getDatabaseKey(uri.toString(true)));
	_sortedWorkspaceFolders = undefined;
	checkRegistrations();
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
			{ scheme: 'file', language: 'typescript', exclusive: true } as any,
			{ scheme: 'file', language: 'javascript', exclusive: true } as any
		];
		let toRegister: BulkRegistration = BulkRegistration.create();
		toRegister.add(DocumentSymbolRequest.type, {
			documentSelector
		});
		toRegister.add(FoldingRangeRequest.type, {
			documentSelector
		});
		toRegister.add(HoverRequest.type, {
			documentSelector
		});
		toRegister.add(DefinitionRequest.type, {
			documentSelector
		});
		toRegister.add(ReferencesRequest.type, {
			documentSelector
		});
		registrations = connection.client.register(toRegister);
	}
}

function getUri(textDocument: TextDocumentIdentifier): string {
	return URI.parse(textDocument.uri).toString(true);
}

function getDatabase(textDocument: TextDocumentIdentifier): [string, LsifDatabase | undefined] {
	let uri = getUri(textDocument);
	return [uri, findDatabase(uri)];
}

connection.onDocumentSymbol((params) => {
	let [uri, database] = getDatabase(params.textDocument);
	if (!database) {
		return null;
	}
	return database.documentSymbols(uri);
});

connection.onFoldingRanges((params) => {
	let [uri, database] = getDatabase(params.textDocument);
	if (!database) {
		return null;
	}
	return database.foldingRanges(uri);
});


connection.onHover((params) => {
	let [uri, database] = getDatabase(params.textDocument);
	if (!database) {
		return null;
	}
	return database.hover(uri, params.position);
});

connection.onDefinition((params) => {
	let [uri, database] = getDatabase(params.textDocument);
	if (!database) {
		return null;
	}
	return database.definitions(uri, params.position);
});

connection.onReferences((params) => {
	let [uri, database] = getDatabase(params.textDocument);
	if (!database) {

		return null;
	}
	return database.references(uri, params.position, params.context);
});


connection.onDidChangeTextDocument((params) => {
	let [uri, database] = getDatabase(params.textDocument);
	if (!database) {
		return null;
	}
	return database.updateLocations(uri, params.contentChanges);
})

connection.listen();
