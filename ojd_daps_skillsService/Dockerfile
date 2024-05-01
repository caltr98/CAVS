# Use a Python base image
FROM python:3.10.4-slim


RUN apt-get update && apt-get install -y git
RUN pip install git+https://github.com/nestauk/ojd_daps_skills.git@dev
RUN pip install flask
RUN python -m spacy download en_core_web_sm

# Copy data into container with complete formatting of skills from own processing
COPY ./setupFunction/ojd_daps_skills_data /usr/local/lib/python3.10/site-packages/ojd_daps_skills_data
COPY ./setupFunction/ojd_daps_skills /usr/local/lib/python3.10/site-packages/ojd_daps_skills


# Set the working directory in the container
WORKDIR /app

# Copy the Python script into the container
COPY ojd_daps_skillsService.py /app/ojd_daps_skillsService.py

# Expose the port that the Flask application will listen on
EXPOSE 5005

CMD ["python", "ojd_daps_skillsService.py"]

