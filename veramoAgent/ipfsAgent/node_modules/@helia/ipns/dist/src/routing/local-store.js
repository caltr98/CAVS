import { Record } from '@libp2p/kad-dht';
import { Key } from 'interface-datastore';
import { CustomProgressEvent } from 'progress-events';
import { equals as uint8ArrayEquals } from 'uint8arrays/equals';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
function dhtRoutingKey(key) {
    return new Key('/dht/record/' + uint8ArrayToString(key, 'base32'), false);
}
/**
 * Returns an IPNSRouting implementation that reads/writes IPNS records to the
 * datastore as DHT records. This lets us publish IPNS records offline then
 * serve them to the network later in response to DHT queries.
 */
export function localStore(datastore) {
    return {
        async put(routingKey, marshalledRecord, options = {}) {
            try {
                const key = dhtRoutingKey(routingKey);
                // don't overwrite existing, identical records as this will affect the
                // TTL
                try {
                    const existingBuf = await datastore.get(key);
                    const existingRecord = Record.deserialize(existingBuf);
                    if (uint8ArrayEquals(existingRecord.value, marshalledRecord)) {
                        return;
                    }
                }
                catch (err) {
                    if (err.name !== 'NotFoundError') {
                        throw err;
                    }
                }
                // Marshal to libp2p record as the DHT does
                const record = new Record(routingKey, marshalledRecord, new Date());
                options.onProgress?.(new CustomProgressEvent('ipns:routing:datastore:put'));
                await datastore.put(key, record.serialize(), options);
            }
            catch (err) {
                options.onProgress?.(new CustomProgressEvent('ipns:routing:datastore:error', err));
                throw err;
            }
        },
        async get(routingKey, options = {}) {
            try {
                const key = dhtRoutingKey(routingKey);
                options.onProgress?.(new CustomProgressEvent('ipns:routing:datastore:get'));
                const buf = await datastore.get(key, options);
                // Unmarshal libp2p record as the DHT does
                const record = Record.deserialize(buf);
                return {
                    record: record.value,
                    created: record.timeReceived
                };
            }
            catch (err) {
                options.onProgress?.(new CustomProgressEvent('ipns:routing:datastore:error', err));
                throw err;
            }
        },
        async has(routingKey, options = {}) {
            const key = dhtRoutingKey(routingKey);
            return datastore.has(key, options);
        },
        async delete(routingKey, options) {
            const key = dhtRoutingKey(routingKey);
            return datastore.delete(key, options);
        }
    };
}
//# sourceMappingURL=local-store.js.map