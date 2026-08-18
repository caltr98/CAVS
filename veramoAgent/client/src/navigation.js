export const actorNavigation = [
    {
        key: "issuer",
        label: "Issuer",
        displayLabel: "Issuer",
        basePath: "/issuer",
        defaultPath: "/issuer/create",
        tasks: [
            { path: "/issuer/create", label: "Create" },
            { path: "/issuer/selective-disclosure", label: "Disclosure" },
        ],
    },
    {
        key: "cavs",
        label: "CAVS",
        displayLabel: "CAVS",
        basePath: "/cavs",
        defaultPath: "/cavs/config",
        tasks: [
            { path: "/cavs/config", label: "Config" },
            { path: "/cavs/issuer-trust", label: "Trust" },
            { path: "/cavs/ocr-oracles", label: "OCR" },
        ],
    },
    {
        key: "author",
        label: "Author",
        displayLabel: "Author",
        basePath: "/author",
        defaultPath: "/author/request",
        tasks: [
            { path: "/author/request", label: "Request" },
            { path: "/author/oracles", label: "OCR" },
            { path: "/author/statements", label: "Present" },
        ],
    },
    {
        key: "reader",
        label: "Reader",
        displayLabel: "Reader",
        basePath: "/reader",
        defaultPath: "/reader/decode-trace",
        tasks: [
            { path: "/reader/decode-trace", label: "Verify" },
            { path: "/reader/history", label: "History" },
        ],
    },
];

export function getActorNavigation(pathname = "") {
    return (
        actorNavigation.find((actor) => pathname.startsWith(actor.basePath)) ||
        actorNavigation[0]
    );
}
