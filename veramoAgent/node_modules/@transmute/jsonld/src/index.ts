import jsonld from 'jsonld';
import { safeCanonize } from "./safeCanonize";

export default {
    ...jsonld,
    safeCanonize
};

