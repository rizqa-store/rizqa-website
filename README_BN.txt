RIZQA Online Store V3 — সহজ সেটআপ

V2-তে SQLite native module-এর কারণে Python/C++ build error হচ্ছিল। V3-তে সেটি বাদ দিয়ে JSON file storage দেওয়া হয়েছে; Python বা C++ লাগবে না।

1) এই ZIP নতুন একটি ফোল্ডারে Extract করুন। সম্ভব হলে OneDrive-এর বাইরে C:\RIZQA_online_store_v3-এ রাখুন।
2) ওই ফোল্ডারে PowerShell খুলুন।
3) npm install
4) নিচের তিনটি command আলাদা আলাদা চালান (নিজের গোপন password ব্যবহার করুন):
   $env:ADMIN_USER="admin"
   $env:ADMIN_PASSWORD="নিজের-শক্তিশালী-পাসওয়ার্ড"
   $env:SESSION_SECRET="একটি-দীর্ঘ-এলোমেলো-গোপন-স্ট্রিং"
5) npm start
6) Chrome: http://localhost:3000
7) Admin username: admin; password: আপনার দেওয়া password।

WhatsApp checkout: 01602918071

গুরুত্বপূর্ণ: localhost শুধু নিজের কম্পিউটারে চলে। সবার জন্য লাইভ করতে hosting/server ও persistent storage দরকার। JSON storage ছোট দোকানের প্রাথমিক সংস্করণ; live production-এর আগে backup, security ও database পরিকল্পনা যাচাই করতে হবে। Password কাউকে পাঠাবেন না।
