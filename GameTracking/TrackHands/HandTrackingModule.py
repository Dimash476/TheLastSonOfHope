import cv2
import mediapipe as mp
import time

class handDetector():
    def __init__(self, mode=False, maxHands = 2, model = 1, detectionCon=0.5, trackingCon = 0.5):
        self.mode = mode
        self.maxHands = maxHands
        self.model = model
        self.detectionCon = detectionCon
        self.trackingCon = trackingCon

        self.mpHands = mp.solutions.hands
        self.hands = self.mpHands.Hands(
            static_image_mode=self.mode,
            max_num_hands=self.maxHands,
            model_complexity=self.model,
            min_detection_confidence=self.detectionCon,
            min_tracking_confidence=self.trackingCon
        )

        self.mpDraw = mp.solutions.drawing_utils

    def process(self, img):
        imgRGB = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        self.result = self.hands.process(imgRGB)
        return self.result


    def findHands(self, img, draw=False):
        if self.result.multi_hand_landmarks:
            for handLms in self.result.multi_hand_landmarks:
                if draw:
                    self.mpDraw.draw_landmarks(img, handLms, self.mpHands.HAND_CONNECTIONS)
        return img

    def findPosition(self, img, draw=False, fingers=None, hand='Left'):
        pointSpec = self.mpDraw.DrawingSpec(color=(0, 255, 255), thickness=2, circle_radius=3)
        lineSpec  = self.mpDraw.DrawingSpec(color=(255, 255, 255), thickness=2)
        lmList = []
        if self.result.multi_hand_landmarks:
            for myHand, handed in zip(self.result.multi_hand_landmarks, self.result.multi_handedness):
                if handed.classification[0].label != hand:
                    continue
                handPoints = []
                for id, lm in enumerate(myHand.landmark):
                    h, w, c = img.shape
                    cx, cy = int(lm.x * w), int(lm.y * h)
                    handPoints.append([id, cx, cy])

                if draw:
                    if fingers is None:
                        self.mpDraw.draw_landmarks(img, myHand, self.mpHands.HAND_CONNECTIONS, pointSpec, lineSpec)
                    else:
                        for id, x, y in handPoints:
                            if id in fingers:
                                cv2.circle(img, (x, y), 5, (255, 255, 0), cv2.FILLED)
                lmList.append(handPoints)

        return lmList

    def getHandType(self):
        hands_type = []
        if self.result.multi_handedness:
            for hand in self.result.multi_handedness:
                hand_label = hand.classification[0].label
                hands_type.append(hand_label)
        return hands_type



# def main():
#     pTime = 0
#     cTIme = 0
#     cap = cv2.VideoCapture(0)
#     detector = handDetector()
#
#     while True:
#         success, img = cap.read()
#         img = cv2.flip(img, 1)
#         img = detector.findHands(img, True)
#         lmList = detector.findPosition(img, draw=True)
#         # if len(lmList) != 0:
#         #     print(lmList[0])
#         #
#         #     if len(lmList) > 1:
#         #         print(lmList[1])
#
#         hands_type = detector.getHandType()
#         print(hands_type)
#
#         cv2.imshow("image", img)
#         cv2.waitKey(1)
#
# if __name__ == "__main__":
#     main()