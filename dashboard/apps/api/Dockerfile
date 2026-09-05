FROM python:3.13-alpine
WORKDIR /opt/magicstick-api
COPY apps/api/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/api/licensing.py ./
ENV PYTHONPATH=/opt/magicstick-api PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
EXPOSE 8080
CMD ["python", "/app/server.py"]
