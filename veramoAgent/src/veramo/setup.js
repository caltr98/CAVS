// Re-export the multisignature/BLS-capable Veramo agent from MultiSignatureVeramo.
// This keeps a single source of truth for the agent configuration while making it
// available under the existing path used by the REST server.
export { agent } from '../../MultiSignatureVeramo/src/veramo/setup.js';
