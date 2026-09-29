import ctypes
import ctypes.wintypes
import sys
import time
from pathlib import Path

from PIL import ImageGrab

user32 = ctypes.windll.user32
user32.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
user32.FindWindowW.restype = ctypes.c_void_p
handle = int(sys.argv[1]) if len(sys.argv) > 1 else user32.FindWindowW(None, 'NEXUS · 首页')
if not handle:
    raise SystemExit('NEXUS window not found')

user32.ShowWindow(ctypes.c_void_p(handle), 9)
user32.SetForegroundWindow(ctypes.c_void_p(handle))
time.sleep(float(sys.argv[2]) if len(sys.argv) > 2 else 1)

rect = ctypes.wintypes.RECT()
if not user32.GetWindowRect(ctypes.c_void_p(handle), ctypes.byref(rect)):
    raise SystemExit('GetWindowRect failed')

filename = sys.argv[3] if len(sys.argv) > 3 else 'desktop-onscreen-diagnostic.png'
output = Path(__file__).resolve().parent.parent / 'screenshots' / filename
ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom)).save(output)
print(output)
