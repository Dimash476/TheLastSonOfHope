# положение носа - напрваление героя
# левая рука появляется в кадре полет, сжимаем кулак ускорение
# правая рука вытягиваем пальцы - уровни усокрения (либо по ступеням скорорсти либо придется менять на плавное адаптивное)
import json

import cv2
import time
from TrackFace import FaceMeshModule as fmm
from TrackHands import HandTrackingModule as htm
import math

#calibration params
is_calibrated = False
nose_coordinates = []
nose_center = []

#face controlling params
deviation = 10
LEFT = False
RIGHT = False
UPPER = False
LOWER = False
NO_HORIZONTAL_MOVE = False
NO_VERTICAL_MOVE = False

yaw = 0.0
pitch = 0.0
max_x = 25
max_up = 15
max_down = 10

#hand controlling params
FLYING = False #left hand
SONIC_SPEED = False

min_len = 17
max_len = 185
k = 0.0



def calibration(position, start_time):
    global is_calibrated, nose_center
    if not is_calibrated:
        if time.time() - start_time < 5.0:
            nose_coordinates.append(position)
        else:
            is_calibrated = True
            print('Calibration finished, calculating the center')
            center_x = sum(p[0] for p in nose_coordinates) / len(nose_coordinates)
            center_y = sum(p[1] for p in nose_coordinates) / len(nose_coordinates)
            nose_center = [int(center_x), int(center_y)]
            print('nose center: ', nose_center)
    return nose_center

def face_movement(position, nose_center):
    global deviation, LEFT, RIGHT, UPPER, LOWER, NO_VERTICAL_MOVE, NO_HORIZONTAL_MOVE
    global yaw, pitch, max_x, max_up, max_down
    deviation_x = position[0] - nose_center[0]
    deviation_y = position[1] - nose_center[1]
    # print('dev x: ', deviation_x, ' dev y: ', deviation_y)

    #left right
    yaw = max(-1, min(1, deviation_x / max_x))
    #up down
    if deviation_y < 0:
        pitch = min(1, -deviation_y / max_up)
    else:
        pitch = -min(1, deviation_y / max_down)
    # print('yaw: ', yaw, ' pitch: ', pitch)

    # # horizontal movement
    # if deviation_x > deviation:
    #     NO_HORIZONTAL_MOVE = False
    #     LEFT = False
    #     RIGHT = True
    #     print('right')
    # elif deviation_x < -deviation:
    #     NO_HORIZONTAL_MOVE = False
    #     RIGHT = False
    #     LEFT = True
    #     print('left')
    # else:
    #     RIGHT = False
    #     LEFT = False
    #     NO_HORIZONTAL_MOVE = True
    #     # print('no horizontal move')
    # # vertical movement
    # if deviation_y < - deviation:
    #     NO_VERTICAL_MOVE = False
    #     LOWER = False
    #     UPPER = True
    #     print('upper')
    # elif deviation_y > deviation:
    #     NO_VERTICAL_MOVE = False
    #     UPPER = False
    #     LOWER = True
    #     print('lower')
    # else:
    #     UPPER = False
    #     LOWER = False
    #     NO_VERTICAL_MOVE = True
        # print('no vertical move')

def left_hand(hand_type, left_cords):
    global FLYING, SONIC_SPEED
    SONIC_SPEED = False
    if 'Left' in hand_type:
        FLYING = True
        for point in left_cords:
            if (point[8][2] > point[6][2] and point[12][2] > point[10][2] and point[16][2] > point[14][2]
            and point[20][2] > point[18][2]):
                SONIC_SPEED = True
        # if SONIC_SPEED:
        #     print('SONIC')
        # else:
        #     print('FLYING')
    else:
        FLYING = False
        # print('No flying')

def right_hand(hand_type):
    if 'Right' in hand_type:
        return True



def main():
    global k, max_len, min_len
    # basic settings
    cap = cv2.VideoCapture(0)
    hand_detector = htm.handDetector()
    face_detector = fmm.FaceDetector(refine_landmarks=False, trackCon=0.3)

    print('Calibration started...')
    start_time = time.time()
    while True:
        success, img = cap.read()
        img = cv2.flip(img, 1)

        # face
        position, img = face_detector.findPositon(img, nose=True)
        nose_cent = calibration(position[1:], start_time)
        if is_calibrated:
            face_movement(position[1:], nose_cent)
            cv2.putText(img, f'yaw: {str(yaw)}', (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (255,230,0),2)
            cv2.putText(img, f'pitch: {str(pitch)}', (10, 70), cv2.FONT_HERSHEY_SIMPLEX, 1, (255,230,0), 2)





        # hands
        hand_detector.process(img)
        hand_type = hand_detector.getHandType()

        left_cords = hand_detector.findPosition(img, True)
        left_hand(hand_type, left_cords)



        if right_hand(hand_type):
            lms = hand_detector.findPosition(img, True, [4, 8], 'Right')
            for i, hand in enumerate(lms):
                # print('thumb: ', hand[4][1:],'index: ', hand[8][1:])
                x1, y1 = hand[4][1], hand[4][2]
                x2, y2 = hand[8][1], hand[8][2]
                length = math.hypot(x2-x1, y2-y1)
                # print('thumb:', x1, y1, ' index:', x2, y2, ' length:', length)
                cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                cv2.line(img, (x1, y1), (x2, y2), (255,255,0), 2)
                cv2.circle(img, (cx, cy), 10, (255, 255, 0), cv2.FILLED)

                k = (length - min_len) / (max_len - min_len)
                k = max(0.0, min(1.0, k))
                # print('speed: ', k)




        metadata = json.dumps({
            "calib": not is_calibrated, "face": True,
            "yaw": yaw, "pitch": pitch,
            "fly": FLYING, "boost": SONIC_SPEED, "k": k,
        })

        print(metadata)

        cv2.imshow('image', img)
        cv2.waitKey(1)

if __name__ == "__main__":
    main()