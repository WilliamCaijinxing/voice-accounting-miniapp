"""
Generate 6 TabBar icons for the voice accounting mini program.
- tab-home / tab-home-active: house icon
- tab-record / tab-record-active: microphone icon
- tab-stats / tab-stats-active: bar chart icon

Normal: #999999 (gray)
Active: #07C160 (WeChat green)
Size: 81x81 with transparent background
"""
from PIL import Image, ImageDraw
import os

SIZE = 81
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "miniprogram", "images")

COLOR_NORMAL = (153, 153, 153, 255)   # #999999
COLOR_ACTIVE = (7, 193, 96, 255)      # #07C160

def draw_home(draw, color):
    """Draw a house icon"""
    c = color
    # Roof (triangle)
    draw.polygon([(40, 12), (12, 38), (68, 38)], fill=c)
    # Body (rectangle)
    draw.rectangle([(20, 38), (60, 68)], fill=c)
    # Door (cut out - draw background color)
    draw.rectangle([(35, 50), (45, 68)], fill=(0, 0, 0, 0))

def draw_record(draw, color):
    """Draw a microphone icon"""
    c = color
    # Mic head (rounded rectangle / capsule)
    draw.rounded_rectangle([(31, 10), (49, 42)], radius=10, fill=c)
    # Mic stand (curved part - approximated with arcs)
    # Left arc
    draw.arc([(22, 28), (40, 48)], start=180, end=270, fill=c, width=4)
    # Right arc
    draw.arc([(40, 28), (58, 48)], start=270, end=360, fill=c, width=4)
    # Bottom connector
    draw.rectangle([(38, 42), (42, 52)], fill=c)
    # Base
    draw.rectangle([(30, 50), (50, 54)], fill=c)
    # Stand
    draw.rectangle([(38, 54), (42, 64)], fill=c)
    # Base plate
    draw.rounded_rectangle([(28, 62), (52, 68)], radius=3, fill=c)

def draw_stats(draw, color):
    """Draw a bar chart icon"""
    c = color
    # Three bars of increasing height
    draw.rounded_rectangle([(14, 45), (28, 68)], radius=3, fill=c)
    draw.rounded_rectangle([(33, 30), (47, 68)], radius=3, fill=c)
    draw.rounded_rectangle([(52, 18), (66, 68)], radius=3, fill=c)

def create_icon(draw_func, color, filename):
    """Create a single icon and save it"""
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw_func(draw, color)
    filepath = os.path.join(OUTPUT_DIR, filename)
    img.save(filepath, "PNG")
    print(f"  Generated: {filename}")
    return filepath

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    icons = [
        ("home", draw_home),
        ("record", draw_record),
        ("stats", draw_stats),
    ]

    print("Generating TabBar icons...")
    for name, func in icons:
        create_icon(func, COLOR_NORMAL, f"tab-{name}.png")
        create_icon(func, COLOR_ACTIVE, f"tab-{name}-active.png")

    print(f"\nDone! 6 icons saved to: {OUTPUT_DIR}")

if __name__ == "__main__":
    main()
