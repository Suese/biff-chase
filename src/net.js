import { Peer } from 'peerjs';
import { scheduleAfter } from './clock.js';

// PeerJS host/client wrappers. Room code IS the host's peer id.
// Direct port of the DiceGame net layer; clients dial the host's id and stay
// connected for the duration of the match.

export class HostNet {
  constructor() {
    this.peer = null;
    this.id = null;
    this.conns = new Map();
    this.connOpen = new Map();
    this.handlers = {
      ready: [],
      action: [],
      connect: [],
      disconnect: [],
      error: [],
    };
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.peer = new Peer({ debug: 1 });
      this.peer.on('open', id => {
        this.id = id;
        for (const cb of this.handlers.ready) cb(id);
        resolve(id);
      });
      this.peer.on('error', err => {
        for (const cb of this.handlers.error) cb(err);
        if (!this.id) reject(err);
      });
      this.peer.on('connection', conn => this._wireConn(conn));
    });
  }

  _wireConn(conn) {
    this.conns.set(conn.peer, conn);
    conn.on('open', () => {
      this.connOpen.set(conn.peer, true);
      for (const cb of this.handlers.connect) cb(conn.peer);
    });
    conn.on('data', data => {
      for (const cb of this.handlers.action) cb(conn.peer, data);
    });
    const onGone = () => {
      this.connOpen.delete(conn.peer);
      this.conns.delete(conn.peer);
      for (const cb of this.handlers.disconnect) cb(conn.peer);
    };
    conn.on('close', onGone);
    conn.on('error', onGone);
  }

  broadcast(msg) {
    for (const [peerId, conn] of this.conns) {
      if (this.connOpen.get(peerId)) {
        try { conn.send(msg); } catch {}
      }
    }
  }

  sendTo(peerId, msg) {
    const conn = this.conns.get(peerId);
    if (conn && this.connOpen.get(peerId)) {
      try { conn.send(msg); } catch {}
    }
  }

  on(evt, cb) { this.handlers[evt].push(cb); }
}

export class ClientNet {
  constructor() {
    this.peer = null;
    this.id = null;
    this.conn = null;
    this.handlers = {
      ready: [],
      open: [],
      message: [],
      close: [],
      error: [],
    };
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.peer = new Peer({ debug: 1 });
      this.peer.on('open', id => {
        this.id = id;
        for (const cb of this.handlers.ready) cb(id);
        resolve(id);
      });
      this.peer.on('error', err => {
        for (const cb of this.handlers.error) cb(err);
        if (!this.id) reject(err);
      });
    });
  }

  connect(hostId) {
    return new Promise((resolve, reject) => {
      this.conn = this.peer.connect(hostId, { reliable: true });
      let opened = false;
      this.conn.on('open', () => {
        opened = true;
        for (const cb of this.handlers.open) cb();
        resolve();
      });
      this.conn.on('data', data => {
        for (const cb of this.handlers.message) cb(data);
      });
      this.conn.on('close', () => {
        for (const cb of this.handlers.close) cb();
      });
      this.conn.on('error', err => {
        for (const cb of this.handlers.error) cb(err);
        if (!opened) reject(err);
      });
      scheduleAfter(12000, () => {
        if (!opened) reject(new Error('Connection timed out — check the room code'));
      });
    });
  }

  send(msg) {
    if (this.conn && this.conn.open) {
      try { this.conn.send(msg); } catch {}
    }
  }

  on(evt, cb) { this.handlers[evt].push(cb); }
}
