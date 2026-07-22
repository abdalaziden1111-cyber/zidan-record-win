# خطة تطوير إعدادات الصوت والمؤثرات البصرية — Zidan Record

> الهدف: الوصول لجودة صوت شبيهة بـ **Adobe Podcast Enhance** ومنظومة فلاتر بصرية (Looks) — بمكونات مفتوحة المصدر بالكامل، تشتغل محليًا على الجهاز بدون إنترنت.
>
> الوضع الحالي: التطبيق فيه ffmpeg مدمج + إلغاء ضوضاء `afftdn`/`arnndn` + whisper.cpp محلي. الرخصة AGPL فتسمح بأي مكوّن MIT/Apache/GPL.

---

## المسار أ — الصوت (الأولوية)

### المرحلة A1: سلسلة "Podcast Voice" الجاهزة (أسبوع — بدون أي مكتبات جديدة)

زر واحد "🎙️ Studio Voice" في الـ Audio Mixer يشغّل سلسلة ffmpeg موجودة عندنا بالفعل:

```
highpass=f=80:t=q:w=0.707,
lowpass=f=12000,
adeclick,
deesser=i=0.4,
acompressor=threshold=-18dB:ratio=3:attack=5:release=120:makeup=4dB:knee=4,
equalizer=f=200:t=q:w=1.0:g=-2,
equalizer=f=3000:t=q:w=1.4:g=2,
equalizer=f=8000:t=q:w=1.2:g=1.5,
speechnorm=e=6.25:r=0.00001:l=1,
loudnorm=I=-16:TP=-1.5:LRA=11
```

- المنطق: high-pass يشيل الهمهمة والبفّات ← de-esser يلجم الصفير ← compressor يوحّد مستوى الكلام ← EQ (قص 200Hz للوضوح + رفع 3kHz للحضور + 8kHz للهواء) ← speechnorm ← loudnorm على معيار البودكاست −16 LUFS (وpreset تاني −14 LUFS لليوتيوب)
- في التصدير النهائي: تشغيل `loudnorm` على مرحلتين (قياس `print_format=json` ثم تطبيق) لدقة أعلى
- Presets مقترحة: **Podcast** / **YouTube** / **Voice-over** (نفس السلسلة بقيم مختلفة)

### المرحلة A2: محرك تحسين الكلام DeepFilterNet3 (٢–٣ أسابيع)

**المرشح الفائز بعد مقارنة كل البدائل** (التفاصيل في الجدول تحت):

- **DeepFilterNet3** — رخصة مزدوجة MIT/Apache (الكود **والموديلات**)، موديل ~2M باراميتر (ميجابايتات قليلة)، أسرع من الوقت الفعلي على CPU عادي (مش محتاج GPU)، صوت 48kHz كامل النطاق
- التكامل: توزيع الـ binary الجاهز `deep-filter` (Rust، self-contained) جنب ffmpeg في `electron/native/bin/` — نفس نمط whisper الحالي بالظبط: معالجة ملف قبل سلسلة ffmpeg
- الاستخدام في الـ UI: مستوى ثالث في قائمة إلغاء الضوضاء: **Off / Light (arnndn) / Strong (afftdn) / Studio (DeepFilterNet)**
- الصدق مع النفس: DFN3 بيلغي الضوضاء والصدى بامتياز لكن **مش بيعيد توليد الصوت** زي Adobe Podcast — الإحساس الـ"Adobe" بيجي من DFN3 + سلسلة A1 مع بعض

### المرحلة A3 (اختيارية لاحقًا): طبقة "Studio Restore" الثقيلة

- **Resemble Enhance** (MIT) أو **ClearerVoice-Studio / MossFormer2_SE_48K** (Apache-2.0، أليبابا 2024–2025، الأحدث والأقوى) — دول بيعيدوا توليد الصوت فعلاً (bandwidth extension) زي Adobe Podcast بالظبط
- المشكلة: PyTorch + مئات الميجابايت + محتاجين GPU عمليًا ← يبقوا **تحميل اختياري** (Pro feature) مش مدمجين في التطبيق
- ClearerVoice هو اللي نراقبه — الأنشط والأحدث

### مقارنة المحركات (خلاصة البحث)

| المحرك | الرخصة | الجودة | الحجم/الأداء | القرار |
|---|---|---|---|---|
| **DeepFilterNet3** | MIT/Apache (كود+موديلات) | ممتازة للدينويز | ميجابايتات، real-time على CPU | ✅ **ندمجه** |
| ClearerVoice (MossFormer2 48K) | Apache-2.0 | أعلى من DFN3 | PyTorch ثقيل، GPU | ⏳ تحميل اختياري لاحقًا |
| Resemble Enhance | MIT | الأقرب لـ Adobe (بيعيد التوليد) | ثقيل جدًا، مجمّد من 2023 | ⏳ بديل للاختياري |
| RNNoise موديلات إضافية (.rnnn) | BSD/مشاع | متوسطة (2018) | صفر تكلفة — عندنا arnndn | ✅ نضيف 2–3 موديلات (`beguiling-drafter`, `somnolent-hogwash`) |
| SpeechBrain MetricGAN+ | Apache-2.0 | جيدة لكن **16kHz فقط** | — | ❌ |
| Meta Denoiser | موديلات **CC-BY-NC** | — | — | ❌ رخصة مانعة |
| NVIDIA CleanUNet | رخصة بحثية + 16kHz | — | — | ❌ |
| VoiceFixer | MIT لكن قديم وبه artifacts | — | — | ❌ |

---

## المسار ب — المؤثرات البصرية (Looks & Filters)

### المرحلة B1: فلاتر ffmpeg الجاهزة (أسبوع–أسبوعين، صفر مكتبات جديدة)

قسم "Filters" جديد في اللوحة اليمنى:

- **تحكمات أساسية**: Brightness / Contrast / Saturation / Gamma (`eq`)، حرارة اللون (`colortemperature`)، Vibrance (`vibrance`)
- **Looks جاهزة**: عبر `curves` presets (vintage, lighter…) + `lut3d` بملفات `.cube`
  - مصدر LUTs برخصة نظيفة: [YahiaAngelo/Film-Luts](https://github.com/YahiaAngelo/Film-Luts) (MIT) + توليد looks خاصة بينا (teal-orange، warm، B&W) نملك رخصتها بالكامل
- **ستايل**: Vignette (`vignette`)، Film grain (`noise`)، Sharpen للـ screen recording (`cas` — الأفضل لمحتوى الشاشة)
- **المعاينة**: CSS filters في Chromium (brightness/contrast/saturate/blur بتطابق `eq`/`gblur` تقريبيًا) — كافية للمرحلة الأولى

### المرحلة B2: تطابق معاينة/تصدير بالبكسل (٢–٣ أسابيع)

- Pipeline معاينة **WebGL2** بيبني الـ"Look" كله في **3D LUT texture** واحدة، والتصدير بيمرر **نفس ملف الـ .cube** لـ `lut3d` في ffmpeg ← تطابق مضمون بالبناء نفسه (نفس أسلوب المحررين الويب المحترفين)
- يفضل يدويًا متطابق: vignette / grain / sharpen (أزواج shader↔ffmpeg قليلة)

### المرحلة B3: الانتقالات (Transitions)

- **gl-transitions** (MIT، ~80 انتقال GLSL) للمعاينة + **xfade-easing** (بينقل نفس الانتقالات لتعبيرات `xfade` الأصلية في ffmpeg) للتصدير — بدون بناء ffmpeg مخصص
- مراجع نتعلم منها: فلاتر MLT (Shotcut/Kdenlive) وOBS

---

## الترتيب المقترح للتنفيذ

| # | المرحلة | المدة التقريبية | القيمة |
|---|---------|-----------------|--------|
| 1 | A1 سلسلة Podcast Voice | أسبوع | أعلى قيمة/مجهود — تحسين فوري محسوس |
| 2 | B1 فلاتر ffmpeg + LUTs | 1–2 أسبوع | قسم Filters كامل بدون dependencies |
| 3 | A2 دمج DeepFilterNet3 | 2–3 أسابيع | القفزة الحقيقية في جودة الصوت |
| 4 | B2 تطابق WebGL2/LUT | 2–3 أسابيع | جودة احترافية للمعاينة |
| 5 | B3 الانتقالات | أسبوعين | ميزة تحريرية جذابة |
| 6 | A3 Studio Restore الاختياري | لاحقًا | Pro tier |
