import cv2
import time
import HandTrackingModule as htm

pTime = 0
cTime = 0
cap = cv2.VideoCapture(0)
detector = htm.handDetector()

while True:
    success, img = cap.read()
    img = cv2.flip(img, 1)
    img = detector.findHands(img, True)
    lmList = detector.findPosition(img, draw=False)
    if len(lmList) != 0:
        print(lmList[0])

    cv2.imshow("Image", img)
    cv2.waitKey(1)