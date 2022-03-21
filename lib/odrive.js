const events = require('events');
const fibre = require('@willsmart/odrive-fibre');
const enums = require('./enums0.5.1.1.json');

function odrive() {
  const self = new events.EventEmitter();
  self.fibre = new fibre();
  self.endpoints = [];
  self.promises = new Set();
  self.readyPromise = Promise.resolve();
  self.readyPromise__resolver = null;
  self.isReady = true;
  self.verbosePropertyAccessors = true;

  const removePromise = promise => {
      if (!self.promises.delete(promise)) return false;
      if (self.promises.size) return true;
      self.isReady = true;
      self.readyPromise__resolver?.();
      self.readyPromise__resolver = null;
      return true;
    },
    addPromise = promise => {
      if (self.promises.has(promise)) return;

      const collectionAwarePromise = promise.finally(() => removePromise(collectionAwarePromise));
      if (self.isReady) {
        self.isReady = false;
        self.readyPromise = new Promise(resolve => (self.readyPromise__resolver = resolve));
      }
      self.promises.add(collectionAwarePromise);
      return collectionAwarePromise;
    };

  function compile(endpoints, parent, namespace) {
    namespace = namespace || '';
    parent = parent || '';
    const object = {};
    endpoints.forEach(function (endpoint) {
      //enumeration
      const enum_path = (namespace.split('_').join('.') + '.' + endpoint.name.split('_').join('.'))
        .split('.')
        .map(function (x) {
          return x.replace(/[0-9]/g, '');
        })
        .map(function (x, i, a) {
          if (x === 'config' || x === 'requested' || x === 'current') {
            return a[i - 1];
          } else {
            return x;
          }
        });
      const enum_name = enum_path.slice(Math.max(enum_path.length - 2, 1)).join('_');
      const is_enum = ['protocol', 'mode', 'type', 'error', 'state'].indexOf(enum_name.split('_').pop()) > -1;
      if ((endpoint.type === 'int32') & is_enum) {
        endpoint.enum = enums[enum_name];
      }
      //serialization
      if (!object[endpoint.name]) {
        object[endpoint.name] = {};
      }
      switch (endpoint.type) {
        case 'object':
          parent = endpoint.name;
          endpoint.namespace = namespace + '.' + endpoint.name;
          if (parent.indexOf('axis') === 0) {
            parent = 'axis';
          }
          object[endpoint.name] = compile(endpoint.members, parent, endpoint.namespace);
          break;
        case 'function':
          endpoint.namespace = namespace + '.' + endpoint.name;
          object[endpoint.name] = async function (...inputValues) {
            return addPromise(
              new Promise(async (resolve, reject) => {
                try {
                  await Promise.all(
                    endpoint.inputs.map((input, i) =>
                      object[endpoint.name].inputs[`${input.name}__set`](inputValues[i])
                    )
                  );
                  self.fibre.get(
                    endpoint.id,
                    0,
                    async () => {
                      const ret = await Promise.all(
                        endpoint.outputs.map((output, i) => object[endpoint.name].outputs[`${output.name}__get`])
                      );
                      resolve(ret.length == 0 ? undefined : ret.length == 1 ? ret[0] : ret);
                    },
                    e => reject(e)
                  );
                } catch (e) {
                  reject(e);
                }
              })
            );
          };
          object[endpoint.name].inputs = compile(endpoint.inputs, parent, endpoint.namespace + '.inputs');
          object[endpoint.name].outputs = compile(endpoint.outputs, parent, endpoint.namespace + '.outputs');

          break;
        default:
          endpoint.namespace = namespace + '.' + endpoint.name;
          marshal(object, endpoint);
          break;
      }
      //reference
      self.endpoints[endpoint.id] = endpoint;
    });
    return object;
  }
  function marshal(object, endpoint, endian = 'LE') {
    let { bitCount, signage } = /^(?<signage>u?)int(?<bitCount>\d+)$/.exec(endpoint.type)?.groups || {};
    let bufferCallType;
    if (bitCount) {
      // eg BigUInt64LE, UInt16LE or Int8
      bufferCallType = `${bitCount > 32 ? 'Big' : ''}${signage.toUpperCase()}Int${bitCount}${
        bitCount > 8 ? endian : ''
      }`;
    } else
      switch (endpoint.type) {
        case 'float':
          bitCount = 32;
          bufferCallType = 'Float' + endian;
          break;
        case 'double':
          bitCount = 64;
          bufferCallType = 'Double' + endian;
          break;
        case 'bool':
          bitCount = 8;
          bufferCallType = 'UInt8';
          break;
      }
    if (bufferCallType) {
      const byteCount = (endpoint.byteCount = bitCount / 8);
      endpoint.getValueFromBuffer = buf => check(buf, byteCount)['read' + bufferCallType]();
      endpoint.getBufferFromValue = value => {
        const buf = Buffer.alloc(byteCount);
        buf['write' + bufferCallType](value);
        return buf;
      };
    }
    switch (endpoint.type) {
      case 'endpoint_ref':
      case 'string':
        endpoint.getValueFromBuffer = buf => buf.toString();
        endpoint.getBufferFromValue = value => Buffer.from(value);
        break;
      case 'json':
        endpoint.getValueFromBuffer = buf => JSON.parse(buf.toString());
        endpoint.getBufferFromValue = value => Buffer.from(JSON.stringify(value));
        break;
      case 'bool':
        const { getValueFromBuffer } = endpoint;
        endpoint.getValueFromBuffer = buf => Boolean(getValueFromBuffer(buf));
        break;
    }
    if (endpoint.enum) {
      const { getValueFromBuffer, getBufferFromValue } = endpoint;
      endpoint.getValueFromBuffer = buf => {
        const v = getValueFromBuffer(buf);
        return endpoint.enum[v] ?? v;
      };
      endpoint.getBufferFromValue = value => {
        const kv = Object.entries(endpoint.enum).find(([_, v]) => v == value);
        return getBufferFromValue(kv?.[0] ?? value);
      };
    }
    if (!endpoint.getBufferFromValue) throw endpoint;

    const get = async () =>
        addPromise(
          new Promise((resolve, reject) => {
            self.fibre.get(
              endpoint.id,
              endpoint.byteCount ?? 512,
              buf => {
                if (!Buffer.isBuffer(buf)) reject(new Error('Not a buffer'));
                resolve((endpoint.cachedValue = endpoint.getValueFromBuffer(buf)));
              },
              e => reject(e)
            );
          })
        ),
      set = async value =>
        addPromise(
          new Promise((resolve, reject) => {
            endpoint.cachedValue = undefined;
            let buffer = endpoint.getBufferFromValue(value);
            if (endpoint.access !== 'rw') return reject(new Error('Error: Access ' + endpoint.access));
            self.fibre.set(
              endpoint.id,
              buffer,
              () => resolve(value),
              e => reject(e)
            );
          })
        );

    function check(buff1, length) {
      if (buff1.length === length) {
        return Buffer.from(buff1);
      } else {
        throw 'Error.' + endpoint.id + ' Buffer mismatch: ' + buff1.length + '!=' + length;
      }
    }

    // This returns a cached value which will be refreshed from the fibre in an async way
    // Note that there are no default values. If no value has been cached yet the property getter will return a promise.
    //
    // Combining this with `readyPromise` makes it pretty easy to reliably get or set many values at once without
    // the hassle of dealing with lots or awaits/thens. eg...
    //
    //> let { a,b,c,d } = od0  // this gets the cached values (if any) and triggers async getters
    //> await odrive.readyPromise // wait for async calls to finish
    //> ({ a,b,c,d } = od0)    // get the newly refreshed cached values
    //
    //> Object.assign(od0, { a:1, b:2, c:3, d:4 }) // or just write to the objewct however you want
    //> await odrive.readyPromise // completes once all values have been sent over the wire
    //
    const loggingGet = () =>
        get()
          .then(v => (self.verbosePropertyAccessors && console.log(`-> [${endpoint.namespace.replace(/^\./,'')}] --> ${JSON.stringify(v)}`), v))
          .catch(
            e => (self.verbosePropertyAccessors && console.error(`!> [${endpoint.namespace.replace(/^\./,'')}] -->! ${e.message}`), undefined)
          ),
      loggingSet = v =>
        set(v)
          .then(() => (self.verbosePropertyAccessors && console.log(`<- [${endpoint.namespace.replace(/^\./,'')}] <== ${JSON.stringify(v)}`), v))
          .catch(
            e => (self.verbosePropertyAccessors && console.error(`<! [${endpoint.namespace.replace(/^\./,'')}] !<== ${e.message}`), undefined)
          );

    Object.defineProperty(object, endpoint.name, {
      get: () => (endpoint.cachedValue !== undefined ? (loggingGet(), endpoint.cachedValue) : loggingGet()),
      set: loggingSet,
    });

    // An alternate getter for the async get/set pair if you want to spin up yopur own promises
    Object.defineProperty(object, endpoint.name + '__get', {
      get: loggingGet,
      set: loggingSet,
      enumerable: false,
    });
    Object.defineProperty(object, endpoint.name + '__set', {
      value: loggingSet,
      writable: false,
      enumerable: false,
    });
    Object.defineProperty(object, endpoint.name + '__endpoint', {
      value: endpoint,
      writable: false,
      enumerable: false,
    });
  }

  function unmarshal(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  self.enums = enums;
  for (const enumGroup of Object.values(enums)) {
    for (const [v, name] of Object.entries(enumGroup)) {
      self[name] = v;
    }
  }
  self.unmarshal = unmarshal;
  self.fibre.on('connect', function () {
    const processSchema = a =>
      Object.fromEntries(
        a
          .slice()
          .sort(({ name: a }, { name: b }) => (a < b ? -1 : a > b ? 1 : 0))
          .map(({ name, members, ...v }) => [name, members ? processSchema(members) : v])
      );

    if (!self.json_bytes) {
      addPromise(
        new Promise((resolve, reject) => {
          self.fibre.get(
            0,
            512,
            function (buffer) {
              self.json_bytes = buffer;
              self.defn = processSchema(JSON.parse(self.json_bytes.toString()));
              self.defn_json = JSON.stringify(self.defn, null, 2);
              self.emit('remoteObject', compile(JSON.parse(self.json_bytes.toString())));
              resolve();
            },
            e => reject(e)
          );
        })
      );
    } else {
      self.emit('remoteObject', compile(JSON.parse(self.json_bytes.toString())));
    }
  });

  return self;
}

module.exports = odrive;
