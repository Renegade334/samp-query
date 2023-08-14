import Crypto = require('node:crypto');
import Datagram = require('node:dgram');
import DNS = require('node:dns');
import Events = require('node:events');
import IP = require('ip');
import Timers = require('node:timers/promises');

declare namespace SAMPQuery {
	interface Info {
		password: boolean;
		players: number;
		maxplayers: number;
		servername: string;
		gamemode: string;
		language: string;
	}
	interface Rules {
		[index: string]: string;
	}
	interface QueryOptions {
		/** If greater than one, then queries will be retried on timeout, up to this total number of attempts. */
		attempts?: number;
		/** The timeout duration for each query attempt, in milliseconds. */
		timeout?: number;
	}
}

type KeyType<T, V> = keyof { [K in keyof T as T[K] extends V ? K : never]: never }
type QueryCode = 'i' | `p${string}` | 'r'
type QueryResponse = { message: Buffer, time: number }

class SAMPQuery {
	defaults: Required<SAMPQuery.QueryOptions>;

	static InvalidMessageError = class InvalidMessageError extends Error {
		constructor(message: string, public response: Buffer) {
			super(message);
		}
	}

	static TimeoutError = class TimeoutError extends Error {
		constructor(public timeout: number) {
			super(`Query timed out after ${timeout}ms`);
		}
	}

	constructor(readonly address: string, readonly port: number, defaultOptions: SAMPQuery.QueryOptions = {}) {
		if (Number.isNaN(port) || port < 1 || port > 65535) {
			throw new RangeError(`Expecting port to be number between 1 and 65535, received ${port}`);
		}

		this.defaults = {
			attempts: defaultOptions.attempts ?? 1,
			timeout: defaultOptions.timeout ?? 5_000,
		};
	}

	async #query(opcode: QueryCode, options: SAMPQuery.QueryOptions): Promise<QueryResponse> {
		const { address } = await DNS.promises.lookup(this.address, { family: 4 });

		const errors: InstanceType<typeof SAMPQuery.TimeoutError>[] = [];
		let attempts = options.attempts ?? this.defaults.attempts;

		while (true) {
			try {
				return await this.#sendPayload(address, opcode, options);
			}
			catch (error) {
				if (error instanceof SAMPQuery.TimeoutError) {
					errors.push(error);
					if (--attempts <= 0) {
						if (errors.length > 1) {
							throw new AggregateError(errors, `Query timed out after ${errors.length} attempts`);
						}
						else {
							throw error;
						}
					}
				}
				else {
					throw error;
				}
			}
		}
	}

	async #sendPayload(address: string, opcode: QueryCode, options: SAMPQuery.QueryOptions): Promise<QueryResponse> {
		const payload = Buffer.from(`SAMP${"\0".repeat(6)}${opcode}`, 'latin1');
		payload.writeUInt32BE(IP.toLong(address), 4);
		payload.writeUInt16LE(this.port, 8);

		const socket = Datagram.createSocket('udp4'), aborter = new AbortController;

		try {
			let time = -Date.now();

			socket.send(payload, this.port, address);

			const [ message ] = await Promise.race([
				Events.once(socket, 'message', { signal: aborter.signal }),
				Timers.setTimeout(options.timeout ?? this.defaults.timeout, Date.now(), { signal: aborter.signal })
					.then(start => Promise.reject(new SAMPQuery.TimeoutError(Date.now() - start)))
			]) as [ Buffer, Datagram.RemoteInfo ];

			time += Date.now();

			if (message.readUInt32BE() !== 0x53414d50) { // 'SAMP'
				throw new SAMPQuery.InvalidMessageError('Invalid header, expected 53414d50', message);
			}

			return { message, time };
		}
		finally {
			aborter.abort();
			socket.close();
		}
	}

	/**
	 * Requests info variables from the query interface.
	 */
	async getInfo(options: SAMPQuery.QueryOptions = {}): Promise<SAMPQuery.Info> {
		const { message } = await this.#query('i', options);

		if (message.readUInt8(10) !== 0x69) { // 'i'
			throw new SAMPQuery.InvalidMessageError('Invalid opcode, not an info payload', message);
		}

		const info: Partial<SAMPQuery.Info> = {
			password: !!message.readInt8(11),
			players: message.readInt16LE(12),
			maxplayers: message.readInt16LE(14)
		};

		let offset = 16;
		const indices: KeyType<SAMPQuery.Info, string>[] = ['servername', 'gamemode', 'language'];
		for (const index of indices) {
			const length = message.readInt32LE(offset);
			info[index] = message.toString('latin1', offset += 4, offset += length);
		}

		return info as SAMPQuery.Info;
	}

	/**
	 * Requests rule variables from the query interface.
	 */
	async getRules(options: SAMPQuery.QueryOptions = {}): Promise<SAMPQuery.Rules> {
		const { message } = await this.#query('r', options);

		if (message.readUInt8(10) !== 0x72) { // 'r'
			throw new SAMPQuery.InvalidMessageError('Invalid opcode, not a rules payload', message);
		}

		const result: SAMPQuery.Rules = {};

		const count = message.readInt16LE(11);
		let offset = 13;

		for (let i = 0; i < count; i++) {
			let length = message.readUInt8(offset);
			const name = message.toString('latin1', ++offset, offset += length);

			length = message.readUInt8(offset);
			const value = message.toString('latin1', ++offset, offset += length);

			result[name] = value;
		}

		return result;
	}

	/**
	 * Sends a ping packet to the query interface.
	 * The returned `Promise` resolves to the round-trip time in milliseconds.
	 *
	 * This function only ever makes one ping attempt, and ignores the `attempts` option.
	 */
	async ping(options: SAMPQuery.QueryOptions = {}): Promise<number> {
		const payload = Crypto.randomBytes(4);

		const { message, time } = await this.#query(`p${payload.toString('latin1')}`, { ...options, attempts: 1 });

		if (message.readUInt8(10) !== 0x70) { // 'p'
			throw new SAMPQuery.InvalidMessageError('Invalid opcode, not a ping payload', message);
		}

		if (payload.compare(message, 11)) {
			throw new SAMPQuery.InvalidMessageError(`Returned payload ${message.toString('hex', 11)} did not match sent payload ${payload.toString('hex')}`, message);
		}

		return time;
	}
}

export = SAMPQuery;
