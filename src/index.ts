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

	#info(buffer: Buffer): SAMPQuery.Info {
		if (buffer.readUInt8(10) !== 0x69) { // 'i'
			throw new SAMPQuery.InvalidMessageError('Invalid opcode, not an info payload', buffer);
		}

		const info: Partial<SAMPQuery.Info> = {
			password: !!buffer.readInt8(11),
			players: buffer.readInt16LE(12),
			maxplayers: buffer.readInt16LE(14)
		};

		let offset = 16;
		const indices: KeyType<SAMPQuery.Info, string>[] = ['servername', 'gamemode', 'language'];
		for (const index of indices) {
			const length = buffer.readInt32LE(offset);
			info[index] = buffer.toString('latin1', offset += 4, offset += length);
		}

		return info as SAMPQuery.Info;
	}

	#rules(buffer: Buffer): SAMPQuery.Rules {
		if (buffer.readUInt8(10) !== 0x72) { // 'r'
			throw new SAMPQuery.InvalidMessageError('Invalid opcode, not a rules payload', buffer);
		}

		const result: SAMPQuery.Rules = {};

		const count = buffer.readInt16LE(11);
		let offset = 13;

		for (let i = 0; i < count; i++) {
			let length = buffer.readUInt8(offset);
			const name = buffer.toString('latin1', ++offset, offset += length);

			length = buffer.readUInt8(offset);
			const value = buffer.toString('latin1', ++offset, offset += length);

			result[name] = value;
		}
		
		return result;
	}

	#ping(buffer: Buffer, payload: Buffer): void {
		if (buffer.readUInt8(10) !== 0x70) { // 'p'
			throw new SAMPQuery.InvalidMessageError('Invalid opcode, not a ping payload', buffer);
		}

		if (payload.compare(buffer, 11)) {
			throw new SAMPQuery.InvalidMessageError(`Returned payload ${buffer.toString('hex', 11)} did not match sent payload ${payload.toString('hex')}`, buffer);
		}
	}

	async #query(opcode: string, options: SAMPQuery.QueryOptions): Promise<Buffer> {
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

	async #sendPayload(address: string, opcode: string, options: SAMPQuery.QueryOptions): Promise<Buffer> {
		const payload = Buffer.from(`SAMP${"\0".repeat(6)}${opcode}`, 'latin1');
		payload.writeUInt32BE(IP.toLong(address), 4);
		payload.writeUInt16LE(this.port, 8);

		const socket = Datagram.createSocket('udp4'), aborter = new AbortController;

		try {
			socket.send(payload, this.port, address);

			const [ message ] = await Promise.race([
				Events.once(socket, 'message', { signal: aborter.signal }),
				Timers.setTimeout(options.timeout ?? this.defaults.timeout, Date.now(), { signal: aborter.signal })
					.then(start => Promise.reject(new SAMPQuery.TimeoutError(Date.now() - start)))
			]) as [ Buffer, Datagram.RemoteInfo ];

			if (message.readUInt32BE() !== 0x53414d50) { // 'SAMP'
				throw new SAMPQuery.InvalidMessageError('Invalid header, expected 53414d50', message);
			}

			return message;
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
		return this.#query('i', options).then(this.#info);
	}

	/**
	 * Requests rule variables from the query interface.
	 */
	async getRules(options: SAMPQuery.QueryOptions = {}): Promise<SAMPQuery.Rules> {
		return this.#query('r', options).then(this.#rules);
	}

	/**
	 * Sends a ping packet to the query interface.
	 * The returned `Promise` resolves to the round-trip time in milliseconds.
	 *
	 * This function only ever makes one ping attempt, and ignores the `attempts` option.
	 */
	async ping(options: SAMPQuery.QueryOptions = {}): Promise<number> {
		const payload = Crypto.randomBytes(4), start = Date.now();
		await this.#query(`p${payload.toString('latin1')}`, { ...options, attempts: 1 }).then(data => this.#ping(data, payload));
		return Date.now() - start;
	}
}

export = SAMPQuery;
