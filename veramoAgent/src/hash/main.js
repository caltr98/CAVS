import { hashAttributes } from './hashAttributes.js';
import { verifyAttributes } from "./verifyAttributes.js";
export async function createVCPayload(jwtofclaims) {
    let disclosure = new Map();
    let toReturn = {};
    let toReturnAttributes = {};
    let toReturnDisclousureSet = {};
    // Iterate over the jwtofclaims object (key-value pairs)
    for (const [attrName, attrValue] of Object.entries(jwtofclaims)) {
        const hashedAttr = await hashAttributes(attrValue, undefined, undefined, undefined);
        disclosure.set(attrName, { path: [attrName], clearValue: attrValue, nonce: hashedAttr.nonce });
        toReturnAttributes[attrName] = hashedAttr.res;
        toReturnDisclousureSet[attrName] = disclosure.get(attrName);
    }
    toReturn['hashedAttributes'] = toReturnAttributes;
    toReturn['disclosure'] = toReturnDisclousureSet;
    console.log("to return is" + JSON.stringify(toReturn, null, 2));
    return toReturn;
}
export function createVPPayload(vcs, keys, disclosures) {
    const VPPayload = [];
    for (let i = 0; i < vcs.length; i++) {
        let disclosure = disclosures[i];
        keys.forEach((key) => {
            if (disclosure[key]) {
                VPPayload.push(disclosure[key]);
            }
            else {
                console.warn(`Key '${key}' not found in disclosure map`);
            }
        });
    }
    console.log("before return " + JSON.stringify(VPPayload, null, 2));
    return VPPayload;
}
export async function verifyVPSelectiveDisclousureCorrectness(jwtVP) {
    let start = performance.now();
    let unverifiedVCs = jwtVP['verifiableCredential'];
    const verifiedVP = jwtVP['attributes'];
    const disclosedAttributeVerification = await verifyAttributes(unverifiedVCs, verifiedVP);
    let end = performance.now();
    const time = (end - start);
    console.log("returning" + disclosedAttributeVerification);
    return disclosedAttributeVerification;
}
