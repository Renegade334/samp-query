## samp-query
A Node.JS class for interrogating the [San Andreas: Multiplayer](https://www.sa-mp.com/) server query interface.

### Installation
```console
$ npm install github:Renegade334/samp-query
```

### Importing
#### CommonJS
```js
const SAMPQuery = require('@renegade334/samp-query');
```
#### ESModule
```js
import SAMPQuery from '@renegade334/samp-query';
```

### API
#### Class methods
```ts
class SAMPQuery {
  new(address: string, port: number, defaults?: SAMPQuery.QueryOptions);

  /**
   * Requests info variables from the query interface.
   */
  async getInfo(options?: SAMPQuery.QueryOptions): Promise<SAMPQuery.Info>;

  /**
   * Requests rule variables from the query interface.
   */
  async getRules(options?: SAMPQuery.QueryOptions): Promise<SAMPQuery.Rules>;

  /**
   * Requests client list (nick, score) from the query interface.
   * Throttled to 100 players.
   */
  async getClientList(options?: SAMPQuery.QueryOptions): Promise<SAMPQuery.Client[]>;

  /**
   * Requests detailed client list (id, nick, score, ping) from the query interface.
   * Throttled to 100 players.
   */
  async getDetailedClientList(options?: SAMPQuery.QueryOptions): Promise<SAMPQuery.DetailedClient[]>;

  /**
   * Sends a ping packet to the query interface. The returned `Promise` resolves to the round-trip time in milliseconds.
   * This function only ever makes one ping attempt, and ignores the `attempts` option.
   */
  async ping(options?: SAMPQuery.QueryOptions): Promise<number>;
}
```

#### Types
```ts
namespace SAMPQuery {
  interface Client {
    nick: string;
    score: number;
  }
  interface DetailedClient extends Client {
    nick: string;
    score: number;
    id: number;
    ping: number;
  }
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
```
