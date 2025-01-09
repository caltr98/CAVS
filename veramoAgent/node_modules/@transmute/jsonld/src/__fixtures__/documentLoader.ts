// eslint-disable-next-line @typescript-eslint/no-explicit-any
const documentLoader = (iri: string): any => {
  console.warn(iri);
  throw new Error(`iri ${iri} not supported`);
};

export default documentLoader;
