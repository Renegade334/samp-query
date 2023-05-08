import Crypto = require('node:crypto');
import Datagram = require('node:dgram');
import DNS = require('node:dns');
import Events = require('node:events');
import IP = require('ip');
import Timers = require('node:timers/promises');

declare namespace SAMPQuery {
	type Info = {
		password: boolean,
		players: number,
		maxplayers: number,
		servername: string,
		gamemode: string,
		language: string
	}
	type Rules = {
		[index: string]: string;
	}
}

type KeyType<T, V> = keyof { [K in keyof T as T[K] extends V ? K : never]: never }

class SAMPQuery {
	#ip?: string;

	constructor(readonly address: string, readonly port: number) {
		if (Number.isNaN(port) || port < 1 || port > 65535) {
			throw new RangeError(`Expecting port to be number between 1 and 65535, received ${port}`);
		}
	}

	#info(buffer: Buffer): SAMPQuery.Info {
		if (buffer.toString('latin1', 10, 11) != 'i') {
			throw new TypeError('Invalid opcode, not an info payload');
		}
		
		const info: Partial<SAMPQuery.Info> = {};

		info.password = Boolean(buffer.readInt8(11));
		info.players = buffer.readInt16LE(12);
		info.maxplayers = buffer.readInt16LE(14);

		let offset = 16;
		const indices: KeyType<SAMPQuery.Info, string>[] = ['servername', 'gamemode', 'language'];
		for (const index of indices) {
			const length = buffer.readInt32LE(offset);
			info[index] = buffer.toString('latin1', offset += 4, offset += length);
		}
		
		return info as SAMPQuery.Info;
	}

	#rules(buffer: Buffer): SAMPQuery.Rules {
		if (buffer.toString('latin1', 10, 11) != 'r') {
			throw new TypeError('Invalid opcode, not a rules payload');
		}

		const result: SAMPQuery.Rules = {};

		const count = buffer.readInt16LE(11);
		let offset = 13;

		for (let i = 0; i < count; i++) {
			const nameLength = buffer.readUInt8(offset);
			const name = buffer.toString('latin1', ++offset, offset += nameLength);
			
			const valueLength = buffer.readUInt8(offset);
			const value = buffer.toString('latin1', ++offset, offset += valueLength);
			
			result[name] = value;
		}
		
		return result;
	}

	async #ping(buffer: Buffer, payload: Buffer): Promise<void> {
		if (buffer.toString('latin1', 10, 11) != 'p') {
			throw new TypeError('Invalid opcode, not a ping payload');
		}

		if (payload.compare(buffer, 11)) {
			throw new Error(`Returned payload ${buffer.toString('hex', 11)} did not match sent payload ${payload.toString('hex')}`);
		}
	}

	async #query(opcode: string): Promise<Buffer> {
		if (!this.#ip) {
			this.#ip = (await DNS.promises.lookup(this.address, { family: 4 })).address;
		}
		
		const payload = Buffer.from(`SAMP${"\0".repeat(6)}${opcode}`, 'latin1');
		payload.writeUInt32BE(IP.toLong(this.#ip), 4);
		payload.writeInt16LE(this.port, 8);
		
		const socket = Datagram.createSocket('udp4');
		socket.send(payload, this.port, this.#ip, (error: Error | null) => error instanceof Error ? socket.emit('error', error) : socket.emit('sent'));

		const aborter = new AbortController;
		
		try {
			await Events.once(socket, 'sent');
		
			const [ message ] = await Promise.race([
				Events.once(socket, 'message', { signal: aborter.signal }),
				Timers.setTimeout(5000, new Error('Query timed out after 5000ms'), { signal: aborter.signal }).then((error: Error) => Promise.reject(error))
			]) as [ Buffer, Datagram.RemoteInfo ];

			if (message.toString('latin1', 0, 4) !== 'SAMP') {
				throw new TypeError('Invalid header, expected 53414d50');
			}
			
			return message;
		}
		finally {
			aborter.abort();
			socket.close();
		}
	}

	async getInfo(): Promise<SAMPQuery.Info> {
		return this.#query('i').then(this.#info);
	}

	async getRules(): Promise<SAMPQuery.Rules> {
		return this.#query('r').then(this.#rules);
	}

	async ping(): Promise<void> {
		const payload = Crypto.randomBytes(4);
		return this.#query(`p${payload.toString('latin1')}`).then(data => this.#ping(data, payload));
	}
}

export = SAMPQuery;
