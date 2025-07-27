from PIL import Image, ImageDraw, ImageFont
import textwrap

def create_post_image(caption, output_path="generated_post.png"):
    img = Image.new("RGB", (1080, 1350), color=(10, 10, 10))
    draw = ImageDraw.Draw(img)
    font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    font = ImageFont.truetype(font_path, 60)
    wrapped_text = textwrap.fill(caption, width=30)
    draw.text((100, 200), wrapped_text, font=font, fill="white")
    img.save(output_path)
    return output_path
