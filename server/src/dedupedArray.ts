/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

export class DedupeArray<T> {

	private _value: T[];
	private makeKey: (value: T) => string | number;
	private stored: Set<string | number>;

	constructor(makeKey: (value: T) => string | number) {
		this._value = [];
		this.makeKey = makeKey;
		this.stored = new Set();
	}

	public get value(): T[] {
		return this._value;
	}

	public push(value: T): void {
		const key = this.makeKey(value);
		if (!this.stored.has(key)) {
			this.stored.add(key);
			this._value.push(value);
		}
	}

	public has(value: T): boolean {
		const key = this.makeKey(value);
		return this.stored.has(key);
	}

	[Symbol.iterator](): IterableIterator<T> {
		let index = 0;
		const iterator: IterableIterator<T> = {
			[Symbol.iterator]() {
				return iterator;
			},
			next: (): IteratorResult<T> => {
				if (index < this._value.length) {
					const result = { value: this._value[index], done: false };
					index++;
					return result;
				} else {
					return { value: undefined, done: true };
				}
			}
		};
		return iterator;
	}
}