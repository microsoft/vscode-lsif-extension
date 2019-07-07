/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { GraphStore } from './graphStore';
import { noopTransformer } from './database';

const db = new GraphStore();
db.load('jsonrpc.db', () => noopTransformer);

// let definitions = db.definitions('file:///c:/Users/dirkb/Projects/mseng/LanguageServer/Node/jsonrpc/src/events.ts', { line: 6, character: 21});
// console.log(JSON.stringify(definitions));

// let folding = db.foldingRanges('file:///c:/Users/dirkb/Projects/mseng/LanguageServer/Node/jsonrpc/src/events.ts');
// console.log(JSON.stringify(folding));

let symbols = db.documentSymbols('file:///c:/Users/dirkb/Projects/mseng/LanguageServer/Node/jsonrpc/src/events.ts');
console.log(JSON.stringify(symbols));