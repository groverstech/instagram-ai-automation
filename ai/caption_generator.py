import openai

def generate_caption(prompt="Generate a creative Instagram caption about AI and automation"):
    # Replace with your OpenAI key or env var
    openai.api_key = "sk-..."

    response = openai.ChatCompletion.create(
        model="gpt-4",
        messages=[
            {"role": "system", "content": "You are a creative social media manager."},
            {"role": "user", "content": prompt}
        ]
    )
    return response.choices[0].message["content"]
