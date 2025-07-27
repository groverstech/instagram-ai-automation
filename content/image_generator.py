from PIL import Image, ImageDraw, ImageFont
import os

def create_post_image(caption: str, output_path="post.png"):
    img = Image.new("RGB", (1080, 1080), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    font_size = 36
    font = ImageFont.truetype(font_path, font_size)
    draw.text((50, 500), caption, fill=(0, 0, 0), font=font)
    img.save(output_path)
    return output_path