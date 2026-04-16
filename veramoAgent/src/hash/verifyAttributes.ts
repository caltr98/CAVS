import { hashAttributes } from './hashAttributes.js';



interface Disclosure {
    path: string[];
    clearValue: string;
    nonce: string;
    attributes?: any; // Add more specific types if needed
}

interface VP {
    vp: {
        attributes: Disclosure[];
    };
}


export const verifyAttributes = async (VCs: any[], VPAttributes: any): Promise<boolean> => {
    const disclosedAttributes = VPAttributes;
    for (const credential of VCs) {
        const claims: any = credential["credentialSubject"];
        if (!claims || !disclosedAttributes) {
            throw new Error('Claims or disclosedAttributes parameters are undefined!');
        }

            for (const element of disclosedAttributes) {
                const { obj, propToVerify } = checkPath(element.path, claims);
                const propertyPath = element.path.join('->');
                if (propToVerify) {
                    const rehashedAttribute = await hashAttributes(element.clearValue, element.nonce);

                    if ( !(rehashedAttribute.res === propToVerify) ) {

                        return false;
                    }
                } else {
                    console.error(`Cannot find claim: ${propertyPath}. Available claims: ${JSON.stringify(obj, null, 4)}`);
                }
            }

    }
    return true;
};



const checkPath = (path: string[], claims: any) => {
    let finalProp: any = undefined;
    let object: { [key: string]: any } = {};

    path.forEach((element) => {
        if (finalProp === undefined) {
            finalProp = claims[element];
            object[element] = finalProp;
        } else {
            finalProp = finalProp[element];
        }
    });

    return { obj: object, propToVerify: finalProp };
};
