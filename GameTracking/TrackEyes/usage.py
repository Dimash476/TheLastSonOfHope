import cv2
import EyeTrackingModule as etm

cap = cv2.VideoCapture(0)
detector = etm.EyeDetector()

while True:
    success, img = cap.read()
    img = cv2.flip(img, 1)
    img = detector.findEyes(img, draw_iris=True, draw_lines=True)

    cv2.imshow('image', img)
    cv2.waitKey(1)