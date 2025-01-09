function createHashFallback(algorithm) {
  const hashFallbackImpl = require('create-hash');
  let normalizedAlgorithm = algorithm.toLowerCase().replace('-', '');
  return hashFallbackImpl(normalizedAlgorithm);
}

function selectHashFunction(crypto) {
  if (!crypto || !crypto.createHash) {
    return createHashFallback;
  }
  return crypto.createHash;
}

module.exports = selectHashFunction;
