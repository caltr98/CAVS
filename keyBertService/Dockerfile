# Use a Python base image
FROM python:3.10-slim

# Set the working directory in the container
WORKDIR /app

# Install dependency keybert from pip
RUN pip install keybert flask

# Copy the Python script into the container
COPY keyBertServer.py /app/keyBertServer.py

EXPOSE 5003

# Command to run the Python script
CMD ["python", "keyBertServer.py"]
