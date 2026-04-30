import socket
import time
import threading

def start_udp_server():
    ip = "127.0.0.1"
    port = 8001
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((ip, port))
    
    print(f"[*] UDP Ethernet Simulation listening on {ip}:{port}")
    
    clients = {} # addr -> last_seen

    def listener():
        while True:
            try:
                data, addr = sock.recvfrom(1024)
                msg = data.decode().strip()
                if msg == "BRIDGE_CONNECT":
                    print(f"[+] Bridge registered from {addr}")
                else:
                    print(f"\n[RECEIVED FROM UI (UDP)] >>> {msg}")
                
                clients[addr] = time.time()
            except: pass

    # Thread for manual server-side input
    def manual_input():
        while True:
            try:
                msg = input("\n[UDP SERVER CONSOLE] Enter message to send: ")
                if msg and clients:
                    for addr in list(clients.keys()):
                        sock.sendto(f"{msg}\n".encode(), addr)
            except: break
    
    threading.Thread(target=manual_input, daemon=True).start()

    print("[*] Streaming data to all registered clients (type above to send)...")
    while True:
        if not clients:
            time.sleep(1)
            continue
            
        messages = [
            "ETH_HLTH: V_RAIL=12.01V | TEMP=44C",
            "ETH_DATA: FRAME_ID=99283 | POS_X=102",
            "ETH_SENS: FLOW=1.2L/s | PRESS=30psi"
        ]
        
        # Cleanup old clients (5s timeout)
        now = time.time()
        for addr, last_seen in list(clients.items()):
            if now - last_seen > 10:
                del clients[addr]
                print(f"[-] Client {addr} timed out")
                continue
                
            try:
                for msg in messages:
                    sock.sendto(f"{msg}\n".encode(), addr)
                time.sleep(1)
            except:
                del clients[addr]

if __name__ == "__main__":
    start_udp_server()
