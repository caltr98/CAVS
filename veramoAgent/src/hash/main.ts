import { hashAttributes } from './hashAttributes.js';
import {verifyAttributes} from "./verifyAttributes.js";


interface Disclosure {
    path: string[];
    clearValue: string;
    nonce: string;
}

interface VCPayload {
    vp: {
        '@context': string[];
        type: string[];
        verifiableCredential: any[];
        attributes: Disclosure[];
    };
}

export async function createVCPayload(jwtofclaims: any) {
    let disclosure = new Map<string, Disclosure>();
    let toReturn:any = {};
    let toReturnAttributes:any = {};
    let toReturnDisclousureSet:any = {};

    // Iterate over the jwtofclaims object (key-value pairs)
    for (const [attrName, attrValue] of Object.entries(jwtofclaims)) {
        const hashedAttr = await hashAttributes(<string>attrValue, undefined, undefined, undefined);
        disclosure.set(attrName,<Disclosure>{path: [attrName], clearValue: attrValue, nonce: hashedAttr.nonce});
        toReturnAttributes[attrName] = hashedAttr.res;
        toReturnDisclousureSet[attrName] = disclosure.get(attrName);
    }


    toReturn['hashedAttributes'] = toReturnAttributes;
    toReturn['disclosure'] = toReturnDisclousureSet
    console.log("to return is"+ JSON.stringify(toReturn, null, 2))
    return toReturn;
}

export function createVPPayload(vcs: any, keys: string[], disclosures: any) {
    const VPPayload: any = [];


    for(let i=0; i<vcs.length; i++) {
        let disclosure = disclosures[i];
        keys.forEach((key) => {
            if (disclosure[key]) {
                VPPayload.push(disclosure[key]);
            } else {
                console.warn(`Key '${key}' not found in disclosure map`);
            }
        });
    }

    console.log("before return "+ JSON.stringify(VPPayload,null,2))
    return VPPayload;
}


export async function verifyVPSelectiveDisclousureCorrectness(jwtVP:any){
    let start = performance.now();
    let unverifiedVCs = jwtVP['verifiableCredential'];
    const verifiedVP = jwtVP['attributes'];
    const disclosedAttributeVerification = await verifyAttributes(unverifiedVCs, verifiedVP);
    let end = performance.now();
    const time = (end-start);
    console.log("returning"+disclosedAttributeVerification)
    return disclosedAttributeVerification;
}