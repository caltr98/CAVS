import { hashAttributes } from './hashAttributes.js';
export const verifyAttributes = async (VCs, VPAttributes) => {
    const disclosedAttributes = VPAttributes;
    for (const credential of VCs) {
        const claims = credential["credentialSubject"];
        if (!claims || !disclosedAttributes) {
            throw new Error('Claims or disclosedAttributes parameters are undefined!');
        }
        for (const element of disclosedAttributes) {
            const { obj, propToVerify } = checkPath(element.path, claims);
            const propertyPath = element.path.join('->');
            if (propToVerify) {
                const rehashedAttribute = await hashAttributes(element.clearValue, element.nonce);
                if (!(rehashedAttribute.res === propToVerify)) {
                    return false;
                }
            }
            else {
                console.error(`Cannot find claim: ${propertyPath}. Available claims: ${JSON.stringify(obj, null, 4)}`);
            }
        }
    }
    return true;
};
const checkPath = (path, claims) => {
    let finalProp = undefined;
    let object = {};
    path.forEach((element) => {
        if (finalProp === undefined) {
            finalProp = claims[element];
            object[element] = finalProp;
        }
        else {
            finalProp = finalProp[element];
        }
    });
    return { obj: object, propToVerify: finalProp };
};
