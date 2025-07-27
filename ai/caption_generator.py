import openai
import os
from dotenv import load_dotenv

load_dotenv()
client = openai.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def generate_caption():
    prompt = (
        "Write a short, engaging Instagram caption based on current market trends in finance or tech. "
        "Use 2 relevant hashtags and emojis. Max 2200 characters."
    )

    try:
        response = client.chat.completions.create(
            model="gpt-4o",  # Try GPT-4o first
            messages=[{"role": "user", "content": prompt}]
        )
    except openai.NotFoundError:
        print("⚠️ gpt-4o not available. Falling back to gpt-3.5-turbo.")
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": prompt}]
        )

    return response.choices[0].message.content.strip()

