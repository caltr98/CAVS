import { Crypto } from '@peculiar/webcrypto'
import selectHashFunction from "./hash.js";

const peculiarWebcrypto = new Crypto()
peculiarWebcrypto.createHash = selectHashFunction(peculiarWebcrypto);
export default peculiarWebcrypto
