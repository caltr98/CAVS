import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

jest.mock("axios", () => ({
    get: jest.fn(),
    post: jest.fn(),
}));
jest.mock("react-drag-drop-files", () => ({
    FileUploader: () => <div data-testid="file-uploader" />,
}));

const axios = require("axios");

function mockGet(url) {
    if (url.includes("/set_secrets")) {
        return Promise.resolve({ data: {} });
    }
    if (url.includes("/peer_id")) {
        return Promise.resolve({ data: { peer_id: "peer-id-1" } });
    }
    if (url.includes("/get_own_did")) {
        return Promise.resolve({
            data: { dids: ["did:ethr:sepolia:0xabc123"] },
        });
    }
    if (url.includes("/api_extractor")) {
        return Promise.resolve({ data: { extractor_engines: ["RoBERTa"] } });
    }
    if (url.includes("/api_enricher")) {
        return Promise.resolve({ data: { enricher_engines: ["Nesta"] } });
    }
    if (url.includes("/api_skills")) {
        return Promise.resolve({ data: { skills_engines: ["OJD-DAPS"] } });
    }
    if (url.includes("/api_competence_mode")) {
        return Promise.resolve({
            data: {
                competence_modes: ["RoBERTa to Nesta mode", "GPT competence service"],
                selectedCompetenceMode: "RoBERTa to Nesta mode",
            },
        });
    }
    if (url.includes("/api_openai_config")) {
        return Promise.resolve({
            data: {
                openAIApiKeyConfigured: false,
                openAIApiKeyMasked: "",
                openAIBaseUrl: "",
                openAIModel: "",
            },
        });
    }
    if (url.includes("/api_selective_disclosure_mode")) {
        return Promise.resolve({
            data: {
                selectiveDisclosureMode: false,
            },
        });
    }
    if (url.includes("/list_verifiable_presentations_with_type")) {
        return Promise.resolve({ data: [] });
    }
    if (url.includes("/api/v0/list-verifiable-credentials-with-type")) {
        return Promise.resolve({ data: [] });
    }

    return Promise.resolve({ data: {} });
}

beforeEach(() => {
    window.history.pushState({}, "", "/");
    axios.get.mockImplementation(mockGet);
    axios.post.mockImplementation((url) => {
        if (url.includes("/setup_did")) {
            return Promise.resolve({ data: { did: "did:ethr:sepolia:0xnew" } });
        }
        return Promise.resolve({ data: {} });
    });
});

test("renders actor navigation and issuer default route", async () => {
    render(<App />);

    expect((await screen.findAllByText("Issuer")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Issue credential")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Spreader")).not.toBeInTheDocument();
});

test("switches to the cavs route while keeping the active did", async () => {
    render(<App />);

    expect((await screen.findAllByDisplayValue("did:ethr:sepolia:0xabc123")).length).toBeGreaterThan(0);
    await userEvent.click(await screen.findByRole("link", { name: "CAVS" }));

    expect(await screen.findByText("Configure")).toBeInTheDocument();
    expect(screen.getAllByDisplayValue("did:ethr:sepolia:0xabc123").length).toBeGreaterThan(0);
});

test("keeps technical detail panels collapsed by default", async () => {
    render(<App />);

    const technicalDetails = (await screen.findAllByText("Technical Details"))[0];
    expect(technicalDetails.closest("details")).not.toHaveAttribute("open");
});

test("moves presentation handoff into the author vault", async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole("link", { name: "Author" }));
    await userEvent.click(await screen.findByRole("link", { name: "Present" }));

    expect((await screen.findAllByText("Present")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Presentation")).toBeInTheDocument();
    expect(await screen.findByText("Reader handoff")).toBeInTheDocument();
});
