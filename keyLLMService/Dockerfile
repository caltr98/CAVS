# syntax=docker/dockerfile:1.6
# Use a Python base image
FROM python:3.10-slim

# Set the working directory in the container
WORKDIR /app

# Install dependencies (force CPU-only torch to avoid huge CUDA wheels)
RUN --mount=type=cache,target=/root/.cache/pip \
  pip install --upgrade pip \
  && pip install --index-url https://download.pytorch.org/whl/cpu torch \
  && pip install flask keybert sentence-transformers openai

# Copy the Python script into the container
COPY keyLLMServer.py /app/keyLLMServer.py


# Expose the port that the Flask application will listen on
EXPOSE 5002

# Command to run the Python script
CMD ["python", "keyLLMServer.py"]
