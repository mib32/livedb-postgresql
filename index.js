'use strict';

var async = require('async');
var fmt   = require('util').format;
var knex  = require('knex');
var pg    = require('pg');

pg.on('end', function onPgEnd() {
  LivePg.willClose = true;
});

/**
 * Get a livedb client for connecting to a PostgreSQL database.
 *
 * @classdesc A PostgreSQL adapter for livedb
 * @class
 * @param {object} opts An object of options
 * @param {string} opts.conn A PostgreSQL connection URL
 * @param {string} opts.table A database table name
 */
function LivePg(opts) {
  this.conn  = required(opts, 'conn');
  this.table = required(opts, 'table');
  this.db    = knex({ client: 'pg', connection: this.conn });
}

/*
 * SNAPSHOT API
 * ============
 */

/**
 * A callback called when getting a document snapshot.
 *
 * @callback LivePg~getSnapshotCallback
 * @param {?Error} err an error
 * @param {?Object} doc document data
 */
/**
 * Get a document snapshot from a given collection.
 *
 * @method
 * @param {string} cName the collection name
 * @param {string} docName the document name
 * @param {LivePg~getSnapshotCallback} cb a callback called with the document
 */
LivePg.prototype.getSnapshot = function getSnapshot(cName, docName, cb) {
  this.db(this.table)
    .where({ collection: cName, name: docName })
    .select('data')
    .limit(1)
    .exec(function onResult(err, rows) {
      if (err) return cb(err, null);
      cb(null, rows.length ? rows[0].data : null);
    });
};

/**
 * A callback called when writing a document snapshot.
 *
 * @callback LivePg~writeSnapshotCallback
 * @param {?Error} err an error
 * @param {?Object} doc document data
 */
/**
 * Write a document snapshot to a given collection.
 *
 * This method uses pg instead of knex because of the complex transaction and
 * locking that's necessary. The lock prevents a race condition between a failed
 * `UPDATE` and the subsequent `INSERT`.
 *
 * @method
 * @param {string} cName the collection name
 * @param {string} docName the document name
 * @param {Object} data the document data
 * @param {LivePg~writeSnapshotCallback} cb a callback called with the document
 */
LivePg.prototype.writeSnapshot = function writeSnapshot(cName, docName, data, cb) {
  var conn  = this.conn;
  var table = this.table;
  var client, done;

  async.waterfall([
    connect,
    begin,
    lock,
    upsert,
    commit
  ], function onDone(err) {
    if (done) done();
    if (err) return cb(err, null);
    cb(null, data);
  });

  function connect(callback) {
    pg.connect(conn, callback);
  }

  function begin(_client, _done, callback) {
    client = _client;
    done   = _done;
    client.query('BEGIN;', callback);
  }

  function lock(res, callback) {
    var _table = client.escapeIdentifier(table);
    var query  = fmt('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE;', _table);
    client.query(query, callback);
  }

  function upsert(res, callback) {
    var _table = client.escapeIdentifier(table);

    var update = fmt('UPDATE %s SET data = $1 ' +
      'WHERE collection = $2 AND name = $3', _table);

    var insert = fmt('INSERT INTO %s (collection, name, data) ' +
      'SELECT $2, $3, $1', _table);

    var query = fmt('WITH upsert AS (%s RETURNING *) %s ' +
      'WHERE NOT EXISTS (SELECT * FROM upsert);', update, insert);

    client.query(query, [data, cName, docName], callback);
  }

  function commit(res, callback) {
    client.query('COMMIT;', callback);
  }
};

/**
 * A callback called when getting snapshots in bulk.
 *
 * @callback LivePg~bulkGetSnapshotCallback
 * @param {?Error} err an error
 * @param {?Object} results the results
 */
/**
 * Get specific documents from multiple collections.
 *
 * @method
 * @param {Object} requests the requests documents
 * @param {LivePg~bulkGetSnapshotCallback} cb a callback called with the results
 */
LivePg.prototype.bulkGetSnapshot = function bulkGetSnapshot(requests, cb) {
  var collections = Object.keys(requests);
  var query       = this.db(this.table).select('collection', 'name', 'data');

  collections.forEach(function eachCName(cName) {
    query
      .orWhereIn('name', requests[cName])
      .andWhere({ collection: cName });
  });

  query.exec(function onDone(err, results) {
    if (err) return cb(err, null);

    results = results.reduce(function eachResult(obj, result) {
      obj[result.collection] = obj[result.collection] || {};
      obj[result.collection][result.name] = result.data;
      return obj;
    }, {});

    // Add collections with no documents found back to the results
    for (var i = 0, len = collections.length; i < len; i++) {
      if (!results[collections[i]]) results[collections[i]] = {};
    }

    cb(null, results);
  });
};

/*
 * OPERATION API
 * =============
 */

/**
 * A callback called when writing an operation
 *
 * @callback LivePg~writeOpCallback
 * @param {?Error} err an error
 * @param {?Object} op the operation data
 */
/**
 * Write an operation.
 *
 * @method
 * @param {string} cName a collection name
 * @param {string} docName a document name
 * @param {Object} opData the operation data
 * @param {LivePg~writeOpCallback} cb a callback called with the op data
 */
LivePg.prototype.writeOp = function writeOp(cName, docName, opData, cb) {
  this.db(this.table)
    .insert({
      collection_name: cName,
      document_name  : docName,
      version        : opData.v,
      data           : opData
    })
    .returning('data')
    .exec(function onResult(err) {
      if (err && err.code !== '23505')
        return cb(err, null);
      cb(null, opData);
    });
};

/**
 * A callback called with the next version of the document
 *
 * @callback LivePg~getVersionCallback
 * @param {?Error} err an error
 * @param {?number} version the next document version
 */
/**
 * Get the next document version.
 *
 * @method
 * @param {string} cName a collection name
 * @param {string} docName a document name
 * @param {LivePg~getVersionCallback} cb a callback called with the next version
 */
LivePg.prototype.getVersion = function getVersion(cName, docName, cb) {
  this.db(this.table)
    .where({ collection_name: cName, document_name: docName })
    .select('version')
    .orderBy('version', 'desc')
    .limit(1)
    .exec(function onResult(err, rows) {
      if (err) return cb(err, null);
      cb(null, rows.length ? parseInt(rows[0].version, 10) + 1 : 0);
    });
};

/**
 * A callback called with ops
 *
 * @callback LivePg~getOpsCallback
 * @param {?Error} err an error
 * @param {?Array(Object)} ops the requested ops
 */
/**
 * Get operations between `start` and `end`, noninclusively.
 *
 * @method
 * @param {string} cName a collection name
 * @param {string} docName a document name
 * @param {number} start the start version
 * @param {?end} end the end version
 * @param {LivePg~getOpsCallback} cb a callback called with the ops
 */
LivePg.prototype.getOps = function getOps(cName, docName, start, end, cb) {
  var query = this.db(this.table)
    .where('version', '>=', start)
    .andWhere({ collection_name: cName, document_name: docName });

  if (typeof end === 'number') {
    query.andWhere('version', '<', end);
  }

  query.select('data')
    .orderBy('version', 'asc')
    .exec(function onResult(err, rows) {
      if (err) return cb(err, null);
      cb(null, rows.map(function eachRow(row) {
        return row.data;
      }));
    });
};

/**
 * Close the connection to the database.
 *
 * @method
 * @param {LivePg~closeCallback} cb a callback called when the connection closes
 */
LivePg.prototype.close = function close(cb) {
  LivePg.close(cb);
};

/**
 * A callback called when the database connection has closed
 *
 * @callback LivePg~closeCallback
 * @static
 */
/**
 * Close the connection to the database.
 *
 * @method
 * @static
 * @param {LivePg~closeCallback} cb a callback called when the connection closes
 */
LivePg.close = function close(cb) {
  if (this.willClose) {
    cb();
  } else {
    pg.once('end', cb);
    pg.end();
  }
};

function required(opts, key) {
  if (!opts[key]) {
    throw new Error('Key "' + key + '" is required in LivePg constructor');
  }

  return opts[key];
}

module.exports = LivePg;
