# CAVS

CAVS (Credibility Assessment and Verification System) is a system for mitigating Fake News in Online Social Network through the use of Self-Sovereign Identity concepts such as Verifiable Credentials.
It leverages Veramo for the SSI framework implementation.
It leverages keyBert and Nesta Skill extractor for processing articles/statements.

## Getting Started

To get started with CAVS, follow the instructions below.

### Prerequisites

- [Docker](https://www.docker.com/get-started) must be installed on your machine.

### Installation

1. **Clone the Repository**

   Clone this repository to your local machine:

   ```bash
   git clone https://github.com/caltr98/CAVS.git
   cd CAVS
   ```
2. **Add Your OpenAI API Key**
  To use the OpenAI service, you need to provide your own OpenAI API key. Create a file named openai_api_key.txt in the keyLLMService directory and add your API key to this file:

  ```bash
  echo "your_openai_api_key_here" > keyLLMService/openai_api_key.txt
  ```
  Replace your_openai_api_key_here with your actual OpenAI API key.


  ### RUN
  Run with Docker Compose
  
  Start the service using Docker Compose:
  ```bash
  docker-compose up
  ```
  This command will build and start all the CAVS composing microservices using Docker.
  
