import json
from openai import OpenAI

def generate_caption(prompt: str) -> str:
    with open("config/secrets.json") as f:
        secrets = json.load(f)

    client = OpenAI(api_key=secrets["openai_api_key"])

    response = client.chat.completions.create(
        model="gpt-3.5-turbo",
        messages=[
            {"role": "user", "content": prompt}
        ],
        max_tokens=60
    )
    return response.choices[0].message.content.strip()