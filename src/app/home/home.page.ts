import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Geolocation } from '@capacitor/geolocation';

declare var Swal: any;

// Koordinat tetap Karawang
const KARAWANG_LAT = -6.3225;
const KARAWANG_LON = 107.3372;

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage implements OnInit {
  weatherData: any;
  city: string = 'Karawang';
  loading: boolean = false;
  isLocating: boolean = false; // Lock untuk mencegah double-click GPS

  // Simpan koordinat & nama terakhir agar refresh tidak pindah lokasi
  public lastLat: number = KARAWANG_LAT;
  public lastLon: number = KARAWANG_LON;
  public lastDisplayName: string = 'Karawang';

  constructor(private http: HttpClient) {}

  ngOnInit() {
    this.loadSavedLocation(); // Load dari storage dulu biar gak loncat
  }

  /**
   * Load lokasi yang tersimpan di localStorage agar saat refresh (F5)
   * lokasi tidak berubah-ubah. Jika tidak ada, baru cari GPS.
   */
  async loadSavedLocation() {
    const savedLat = localStorage.getItem('lastLat');
    const savedLon = localStorage.getItem('lastLon');
    const savedName = localStorage.getItem('lastDisplayName');

    if (savedLat && savedLon && savedName) {
      this.lastLat = parseFloat(savedLat);
      this.lastLon = parseFloat(savedLon);
      this.lastDisplayName = savedName;
      await this.getWeatherKarawang(this.lastDisplayName, this.lastLat, this.lastLon);
    } else {
      await this.requestLocationAndLoad();
    }
  }

  /**
   * Minta izin akses lokasi secara eksplisit,
   * lalu baca GPS SEKALI dan simpan hasilnya.
   */
  async requestLocationAndLoad() {
    this.loading = true;

    try {
      // Pada Web/Chrome, getCurrentPosition akan otomatis memicu prompt izin.
      // Kita panggil langsung agar lebih reliabel di browser.
      const coordinates = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0 // Paksa ambil lokasi baru, jangan pakai cache
      });
      // 3. Cek akurasi dan jarak
      const lat = coordinates.coords.latitude;
      const lon = coordinates.coords.longitude;
      const accuracy = coordinates.coords.accuracy;

      // Jika akurasi sangat buruk (> 5km), kemungkinan besar IP Geolocation yang salah
      if (accuracy > 5000) {
        throw new Error('Akurasi GPS terlalu rendah');
      }

      const distance = this.getDistanceKm(lat, lon, KARAWANG_LAT, KARAWANG_LON);

      if (distance <= 35) { // Radius 35km mencakup hampir seluruh Karawang
        // Di dalam area Karawang → verifikasi lewat nama alamat
        let subArea = 'Karawang';
        try {
          const revGeoUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
          const revData: any = await firstValueFrom(this.http.get(revGeoUrl));
          const addr = revData.address;

          // CEK APAKAH BENAR DI KARAWANG
          // Nominatim biasanya menaruh 'Karawang' di county atau city
          const isKarawang = 
            (addr.county && addr.county.toLowerCase().includes('karawang')) ||
            (addr.city && addr.city.toLowerCase().includes('karawang')) ||
            (addr.municipality && addr.municipality.toLowerCase().includes('karawang'));

          if (!isKarawang) {
            console.warn('Lokasi terdeteksi di luar Karawang:', addr);
            throw new Error('Lokasi di luar Karawang');
          }

          const desa = addr.village || addr.hamlet || addr.suburb || '';
          const kecamatan = addr.city_district || addr.town || addr.municipality || '';

          if (desa && kecamatan) {
            subArea = `${desa}, ${kecamatan}`;
          } else {
            subArea = desa || kecamatan || 'Karawang';
          }
        } catch (e) {
          // Jika error atau di luar Karawang, fallback ke pusat Karawang
          await this.getWeatherKarawang();
          return;
        }

        // SIMPAN PERMANEN
        this.lastLat = lat;
        this.lastLon = lon;
        this.lastDisplayName = subArea;
        
        localStorage.setItem('lastLat', lat.toString());
        localStorage.setItem('lastLon', lon.toString());
        localStorage.setItem('lastDisplayName', subArea);

        await this.getWeatherKarawang(subArea, lat, lon);
      } else {
        // Di luar Karawang
        Swal.fire({
          icon: 'warning',
          title: 'Di Luar Area Karawang',
          text: `Lokasi Anda ${distance.toFixed(0)} km dari Karawang. Aplikasi ini hanya tersedia untuk daerah Karawang.`,
          confirmButtonText: 'OK',
          confirmButtonColor: '#3085d6'
        });
        await this.getWeatherKarawang();
      }

    } catch (error: any) {
      console.warn('GPS error:', error);
      
      const isDenied = error.message?.toLowerCase().includes('denied') || error.code === 1;
      const isOutside = error.message === 'Lokasi di luar Karawang';

      Swal.fire({
        icon: isOutside ? 'info' : (isDenied ? 'warning' : 'error'),
        title: isOutside ? 'Di Luar Karawang' : (isDenied ? 'Izin Lokasi Dibutuhkan' : 'Lokasi Gagal'),
        text: isOutside 
          ? 'Maaf, aplikasi ini difokuskan untuk wilayah Karawang. Menampilkan cuaca pusat Karawang.'
          : (isDenied 
              ? 'Silakan aktifkan izin lokasi di pengaturan browser agar cuaca akurat.' 
              : 'Gagal mendapatkan lokasi. Menampilkan cuaca pusat Karawang.'),
        confirmButtonText: 'Paham',
        confirmButtonColor: '#3085d6'
      });
      await this.getWeatherKarawang();
    } finally {
      this.loading = false;
    }
  }

  /**
   * Tombol GPS: baca ulang lokasi device (hanya jika user klik manual).
   * Dilengkapi lock agar tidak bug saat double-click.
   */
  async getCurrentLocation() {
    if (this.isLocating || this.loading) {
      return;
    }
    this.isLocating = true;
    // Panggil ulang requestLocationAndLoad untuk baca GPS baru
    await this.requestLocationAndLoad();
    this.isLocating = false;
  }

  /**
   * Hitung jarak antara 2 titik koordinat dalam KM (Haversine formula)
   */
  private getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Refresh cuaca menggunakan koordinat terakhir yang tersimpan,
   * sehingga tidak pindah lokasi saat di-refresh.
   */
  async refreshWeather() {
    if (this.loading) return;
    await this.getWeatherKarawang(this.lastDisplayName, this.lastLat, this.lastLon);
  }

  /**
   * Ambil data cuaca untuk area Karawang.
   * Jika lat/lon diberikan (dari GPS), gunakan koordinat tersebut untuk akurasi.
   * Jika tidak, gunakan koordinat pusat Karawang sebagai default.
   */
  async getWeatherKarawang(displayName: string = 'Karawang', gpsLat?: number, gpsLon?: number) {
    this.loading = true;
    try {
      // Gunakan koordinat GPS jika tersedia, jika tidak pakai pusat Karawang
      const lat = gpsLat ?? KARAWANG_LAT;
      const lon = gpsLon ?? KARAWANG_LON;

      // 1: Dapatkan Data Cuaca Real-time & Prediksi Detail (Open-Meteo Forecast)
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,weather_code,is_day,uv_index,visibility&hourly=temperature_2m,weather_code,precipitation_probability&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
      const weatherRaw: any = await firstValueFrom(this.http.get(weatherUrl));

      // 2: Dapatkan Kualitas Udara (Open-Meteo Air Quality - GRATIS)
      const airQualityUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,pm2_5,pm10&timezone=auto`;
      const airQualityRaw: any = await firstValueFrom(this.http.get(airQualityUrl));
      
      const current = weatherRaw.current;
      const wmoCode = current.weather_code;
      const isDay = current.is_day === 1;
      
      // Mengubah kode cuaca standar WMO menjadi format bawaan yg sudah didesain
      const mapWmo = (code: number, isDay: boolean = true) => {
         const s = isDay ? 'd' : 'n';
         if (code === 0) return { id: 800, desc: isDay ? 'Cerah' : 'Cerah (Malam)', icon: `01${s}` };
         if (code === 1) return { id: 801, desc: 'Sebagian Cerah', icon: `02${s}` };
         if (code === 2) return { id: 802, desc: 'Berawan', icon: `03${s}` };
         if (code === 3) return { id: 804, desc: 'Mendung', icon: `04${s}` };
         if ([45, 48].includes(code)) return { id: 741, desc: 'Berkabut', icon: `50${s}` };
         if ([51, 53, 55, 56, 57].includes(code)) return { id: 300, desc: 'Gerimis', icon: `09${s}` };
         if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { id: 500, desc: 'Hujan', icon: `10${s}` };
         if ([71, 73, 75, 77, 85, 86].includes(code)) return { id: 600, desc: 'Salju', icon: `13${s}` };
         if ([95, 96, 99].includes(code)) return { id: 200, desc: 'Badai Petir', icon: `11${s}` };
         return { id: 800, desc: isDay ? 'Cerah' : 'Malam', icon: `01${s}` };
      };
      
      const wWeather = mapWmo(wmoCode, isDay);

      // Memalsukan respons seperti format JSON OpenWeatherMap lama agar UI HTML tidak perlu dirombak!
      this.weatherData = {
        name: displayName,
        sys: { country: 'ID' },
        main: { 
          temp: current.temperature_2m, 
          humidity: current.relative_humidity_2m, 
          pressure: current.surface_pressure || 1012
        },
        wind: { speed: current.wind_speed_10m },
        weather: [{ id: wWeather.id, description: wWeather.desc, icon: wWeather.icon }],
        // Data Premium Tambahan
        uvIndex: current.uv_index,
        visibility: current.visibility / 1000, // Ubah ke KM
        aqi: airQualityRaw.current.us_aqi,
        pm25: airQualityRaw.current.pm2_5,
        // Data Tambahan untuk Prediksi
        hourly: weatherRaw.hourly.time.slice(0, 24).map((time: any, i: number) => ({
          time: time,
          temp: weatherRaw.hourly.temperature_2m[i],
          icon: mapWmo(weatherRaw.hourly.weather_code[i]).icon,
          pop: weatherRaw.hourly.precipitation_probability[i] // Probability of Precipitation
        })),
        daily: weatherRaw.daily.time.slice(1, 5).map((time: any, i: number) => ({
          date: time,
          maxTemp: weatherRaw.daily.temperature_2m_max[i + 1],
          minTemp: weatherRaw.daily.temperature_2m_min[i + 1],
          desc: mapWmo(weatherRaw.daily.weather_code[i + 1]).desc,
          icon: mapWmo(weatherRaw.daily.weather_code[i + 1]).icon,
          pop: weatherRaw.daily.precipitation_probability_max[i + 1]
        })),
        advice: this.getWeatherAdvice(wmoCode)
      };
      
    } catch (e: any) {
      console.warn('API Error:', e);
      // Fallback Data untuk Keamanan Demo
      this.weatherData = {
        name: 'Karawang',
        sys: { country: 'ID' },
        main: { temp: 0, humidity: 0, pressure: 0 },
        wind: { speed: 0 },
        weather: [{ id: 800, description: 'Gagal Memuat Data', icon: '01d' }]
      };
    } finally {
      this.loading = false;
    }
  }



  getWeatherIcon() {
    if (!this.weatherData) return 'assets/shapes.svg';
    const iconCode = this.weatherData.weather[0].icon;
    return `https://openweathermap.org/img/wn/${iconCode}@4x.png`;
  }

  getDynamicBg() {
    if (!this.weatherData) return 'linear-gradient(to bottom, #1D80D2, #60A5FA)';
    const code = this.weatherData.weather[0].id;
    const isNight = this.weatherData.weather[0].icon.includes('n');
    
    // Apple Weather iOS Core Gradients
    if (code >= 200 && code < 600) {
      // Rain/Storm (Slate Blue)
      return isNight ? 'linear-gradient(to bottom, #1E293B, #0F172A)' : 'linear-gradient(to bottom, #475569, #94A3B8)';
    }
    if (code >= 600 && code < 700) {
      // Snow (Frost Gray)
      return isNight ? 'linear-gradient(to bottom, #0F172A, #334155)' : 'linear-gradient(to bottom, #8BA2B2, #CBD5E1)'; 
    }
    if (code >= 700 && code < 800) {
      // Fog (Dusty Gray)
      return isNight ? 'linear-gradient(to bottom, #2C3E50, #475569)' : 'linear-gradient(to bottom, #7C8B99, #B8C6D5)';
    }
    if (isNight) {
      // Clear Apple Night (Deep Indigo cyan)
       return 'linear-gradient(to bottom, #061928, #183C58)'; 
    }
    
    // Clear/Clouds Day
    if (code === 800) return 'linear-gradient(to bottom, #4292DF, #7DBDF4)'; // Sunny Apple Blue
    if (code === 801 || code === 802) return 'linear-gradient(to bottom, #5097D8, #86BDE8)'; // Partly Cloudy
    
    return 'linear-gradient(to bottom, #5B7A92, #94B1C5)'; // Heavy Overcast / Neutral Cloud
  }

  getWeatherAdvice(code: number) {
    if (code === 0) return 'Cuaca sangat cerah! Gunakan kacamata hitam dan tabir surya jika keluar.';
    if (code >= 1 && code <= 3) return 'Cuaca cukup bersahabat. Cocok untuk aktivitas luar ruangan.';
    if ([45, 48].includes(code)) return 'Jarak pandang terbatas karena kabut. Berhati-hatilah saat berkendara.';
    if (code >= 51 && code <= 67) return 'Sedia payung sebelum hujan! Gunakan pakaian hangat agar tidak kedinginan.';
    if (code >= 71 && code <= 77) return 'Sangat dingin! Gunakan jaket tebal jika ingin bermain salju.';
    if (code >= 80 && code <= 82) return 'Hujan deras mendadak. Sebaiknya tunda aktivitas luar ruangan.';
    if (code >= 95) return 'Waspada badai dan petir! Tetaplah di dalam ruangan yang aman.';
    return 'Periksa cuaca secara berkala untuk tetap waspada.';
  }

  get weatherAnimType() {
    if (!this.weatherData) return 'clear';
    const code = this.weatherData.weather[0].id;
    const isNight = this.weatherData.weather[0].icon.includes('n');
    
    if (code >= 200 && code < 600) return 'rain';
    if (code >= 801 && code <= 804) return isNight ? 'night-clouds' : 'clouds';
    if (isNight) return 'night';
    
    return 'clear';
  }
}
