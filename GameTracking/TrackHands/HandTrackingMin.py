import mediapipe as mp
import cv2
import time

mpHands = mp.solutions.hands
hands = mpHands.Hands(max_num_hands=2)
mpDraw = mp.solutions.drawing_utils

pTime = 0
cTIme = 0

cap = cv2.VideoCapture(0)

while True:
    success, img = cap.read()
    img = cv2.flip(img, 1)
    imgRGB = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    result = hands.process(imgRGB)
    # print(result)


    # if result.multi_handedness:
    #     for hand in result.multi_handedness:
    #         print(hand.classification[0].label)


    if result.multi_hand_landmarks:
        # print(len(result.multi_hand_landmarks))
        for handLms in result.multi_hand_landmarks:
            # print(handLms)
            for id, lm in enumerate(handLms.landmark):
                # print(id, lm)
                h, w , c = img.shape
                cx, cy = int(w * lm.x), int(h * lm.y)
                # print(id, cx, cy)
                # if id == 0:
                #     cv2.circle(img, (cx, cy), 10, (255,0,0),cv2.FILLED)
            mpDraw.draw_landmarks(img, handLms, mpHands.HAND_CONNECTIONS)

    cTime = time.time()
    fps = 1/(cTime-pTime)
    pTime = cTime

    cv2.putText(img, str(int(fps)), (10,70), cv2.FONT_HERSHEY_PLAIN,5,(255,255,0),3)
    # print(success)
    cv2.imshow("Image", img)
    cv2.waitKey(1)