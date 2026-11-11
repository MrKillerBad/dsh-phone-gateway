Conventions for this Android project (read before editing any file here).
=======================================================================

1. NO GRADLE. This machine has the Android SDK and a JDK but no Gradle, and the
   npm/pnpm registry is unreachable. The APK is assembled with the raw SDK
   command-line tools (javac -> d8 -> aapt2 -> zipalign -> apksigner) by
   build/build.ps1. Do not add a build.gradle: it cannot be executed here.

2. FILES WRITTEN BY POWERSHELL MUST BE UTF-8 WITHOUT BOM. Windows PowerShell
   writes a BOM by default, and javac rejects it ("illegal character: '\ufeff'").
   Always use:
       [System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))

3. d8.bat USES THE JDK FROM PATH, WHICH IS A JRE 8 HERE. It cannot run d8
   (class file version 55 vs 52). Either set JAVA_HOME to Android Studio's JBR,
   or invoke d8 directly:
       java -cp <build-tools>/lib/d8.jar com.android.tools.r8.D8 <args>

4. PATHS ARE PASSED AS A JAR TO d8, NOT AS .class FILES. PowerShell splits
   strings containing "D:\..." on the colon when calling native commands.
   Jar the classes first, then hand d8 a single path.

5. java sources target --release 17 (JBR is 25; android.jar is api 37).

6. THE APP MUST NEVER ASSUME AN ADDRESS. Discovery (UDP broadcast) is the
   primary path; a typed address is the fallback. An IP-encoded QR code or a
   fixed host would break every time the phone joins a different network.

7. build.ps1 PUBLISHES THE APK INTO THE GATEWAY (step 9). It copies the signed
   APK to ../dsh-phone-gateway/assets/ and writes app.json beside it, so the
   gateway can serve /__lan/app to a phone that has not paired yet. The signing
   keystore is deliberately NOT copied — shipping it would let anyone sign an
   update to "this app". Never add it to the copy list.

