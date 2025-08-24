// server.js
// --- 1. IMPORT CÁC THƯ VIỆN CẦN THIẾT ---
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken'); 
const path = require('path');
require('dotenv').config();

// --- 2. KHỞI TẠO SERVER & CẤU HÌNH ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const port = process.env.PORT || 3000;

// --- 3. CẤU HÌNH MIDDLEWARE ---
// *** FIX: Cấu hình CORS đầy đủ để xử lý các yêu cầu phức tạp (như gửi file) ***
const corsOptions = {
    origin: '*', // Cho phép tất cả các domain.
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Xử lý các yêu cầu pre-flight

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));


// --- 4. KẾT NỐI DATABASE & CẤU HÌNH CLOUDINARY ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('✅ Đã kết nối thành công tới MongoDB Atlas!');
        listenForDBChanges();
    })
    .catch(err => console.error('🔴 Lỗi kết nối MongoDB:', err));

// --- 5. SCHEMA DỮ LIỆU ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['admin', 'staff'], default: 'staff' },
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

const employeeSchema = new mongoose.Schema({
    name: { type: String, required: true, maxlength: 100 },
    department: { type: String, required: true, maxlength: 100 },
}, { timestamps: true });
const Employee = mongoose.model('Employee', employeeSchema);

const supplierSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true, maxlength: 150 },
}, { timestamps: true });
const Supplier = mongoose.model('Supplier', supplierSchema);

const vehicleSchema = new mongoose.Schema({
    licensePlate: { type: String, required: true, unique: true, maxlength: 15 },
    driverName: { type: String, maxlength: 50 },
    driverIdCard: { type: String, unique: true, sparse: true, maxlength: 12 },
    vehicleType: { type: String, maxlength: 50 },
    lastRegistered: { type: Date, default: Date.now }
}, { timestamps: true });
const Vehicle = mongoose.model('Vehicle', vehicleSchema);

const registrationSchema = new mongoose.Schema({
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    reason: { type: String, required: true, maxlength: 200 },
    priority: { type: String, required: true, enum: ['Thấp', 'Trung bình', 'Cao'], default: 'Trung bình' },
    expectedDate: { type: Date, required: true },
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
    status: { type: String, enum: ['Chờ khai báo', 'Đã khai báo', 'Đã vào cổng', 'Đã rời cổng'], default: 'Chờ khai báo' },
    imageUrls: { idCardPhoto: String, licensePlatePhoto: String, vehiclePhoto: String },
    checkInTime: Date,
    checkOutTime: Date,
}, { timestamps: true });
const Registration = mongoose.model('Registration', registrationSchema);


// --- 6. LOGIC REAL-TIME (WEBSOCKET) ---
const broadcastUpdate = () => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'update' }));
        }
    });
};

function listenForDBChanges() {
    const changeStream = Registration.watch([], { fullDocument: 'updateLookup' });
    changeStream.on('change', () => {
        console.log('Database changed, sending update signal.');
        broadcastUpdate();
    });
    console.log('👂 Đang lắng nghe các thay đổi từ database...');
}

wss.on('connection', ws => console.log('ℹ️ Một client đã kết nối WebSocket.'));

// --- 7. CÁC API ENDPOINTS (Không bảo mật) ---

// API xác thực: Đăng nhập (Vẫn giữ lại phòng khi cần)
app.post('/api/auth/login', async (req, res, next) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
        }
        const token = jwt.sign({ id: user._id, role: user.role, username: user.username }, process.env.JWT_SECRET || 'secret', { expiresIn: '8h' });
        res.status(200).json({ token, role: user.role, username: user.username });
    } catch (error) {
        next(error);
    }
});

// --- API QUẢN LÝ ---
// (Toàn bộ các API /api/admin/* được giữ nguyên)
// ...

// --- API NGHIỆP VỤ ---
app.post('/api/requests', async (req, res, next) => {
    try {
        const { employeeName, employeeDepartment, supplierName, expectedDate, reason, priority } = req.body;
        
        if (!employeeName || !employeeDepartment || !supplierName || !expectedDate || !reason || !priority) {
            return res.status(400).json({ message: 'Vui lòng điền đầy đủ tất cả thông tin.' });
        }
        
        const employee = await Employee.findOneAndUpdate(
            { name: employeeName, department: employeeDepartment },
            { $set: { name: employeeName, department: employeeDepartment } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const supplier = await Supplier.findOneAndUpdate(
            { name: supplierName },
            { $set: { name: supplierName } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const newRequest = new Registration({ 
            employee: employee._id, 
            supplier: supplier._id, 
            expectedDate, 
            reason, 
            priority 
        });

        await newRequest.save();
        res.status(201).json({ message: 'Tạo yêu cầu thành công!', id: newRequest._id });
    } catch (error) {
        next(error);
    }
});

app.get('/api/requests/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'ID không hợp lệ.' });
        }
        const request = await Registration.findById(id).populate('employee').populate('supplier');
        if (!request) {
            return res.status(404).json({ message: 'Không tìm thấy yêu cầu.' });
        }
        res.status(200).json({
            employeeName: request.employee ? request.employee.name : 'Không rõ',
            department: request.employee ? request.employee.department : 'Không rõ',
            expectedDate: request.expectedDate,
            supplierName: request.supplier ? request.supplier.name : 'Không rõ',
            reason: request.reason,
        });
    } catch (error) {
        next(error);
    }
});
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
app.put('/api/declarations/:id', upload.fields([
    { name: 'idCardPhoto', maxCount: 1 }, { name: 'licensePlatePhoto', maxCount: 1 }, { name: 'vehiclePhoto', maxCount: 1 }
]), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { driverName, driverIdCard, licensePlate, vehicleType } = req.body;
        const files = req.files;

        if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'ID không hợp lệ.' });

        const normalizedLicensePlate = licensePlate.toUpperCase();
        let vehicle = await Vehicle.findOneAndUpdate(
            { licensePlate: normalizedLicensePlate },
            { driverName, driverIdCard, vehicleType, lastRegistered: new Date() },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        const uploadToCloudinary = (file) => new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream({ folder: "driver_registrations" }, (err, result) => err ? reject(err) : resolve(result.secure_url));
            stream.end(file.buffer);
        });

        const [idCardUrl, licensePlateUrl, vehicleUrl] = await Promise.all([
            uploadToCloudinary(files.idCardPhoto[0]),
            uploadToCloudinary(files.licensePlatePhoto[0]),
            uploadToCloudinary(files.vehiclePhoto[0])
        ]);

        const updatedDeclaration = await Registration.findByIdAndUpdate(id, {
            status: 'Đã khai báo',
            imageUrls: { idCardPhoto: idCardUrl, licensePlatePhoto: licensePlateUrl, vehiclePhoto: vehicleUrl },
            vehicle: vehicle._id
        }, { new: true });

        if (!updatedDeclaration) return res.status(404).json({ message: 'Không tìm thấy yêu cầu.' });
        res.status(200).json({ message: 'Khai báo thành công!' });
    } catch (error) {
        next(error);
    }
});

app.get('/api/registrations', async (req, res, next) => {
    try {
        const registrations = await Registration.find({})
            .populate('employee', 'name department')
            .populate('supplier', 'name')
            .populate('vehicle', 'licensePlate driverName driverIdCard vehicleType')
            .sort({ createdAt: -1 });
        res.status(200).json(registrations);
    } catch (error) {
        next(error);
    }
});
const handleCheckAction = async (req, res, action) => {
    try {
        const { id } = req.params;
        const update = action === 'checkin'
            ? { status: 'Đã vào cổng', checkInTime: new Date() }
            : { status: 'Đã rời cổng', checkOutTime: new Date() };

        const updated = await Registration.findByIdAndUpdate(id, update, { new: true })
            .populate('employee', 'name department')
            .populate('supplier', 'name')
            .populate('vehicle', 'licensePlate driverName driverIdCard vehicleType');

        if (!updated) return res.status(404).json({ message: 'Không tìm thấy' });
        res.status(200).json(updated);
    } catch (error) {
        res.status(500).json({ message: 'Lỗi máy chủ nội bộ.' });
    }
};
app.post('/api/registrations/:id/checkin', (req, res) => handleCheckAction(req, res, 'checkin'));
app.post('/api/registrations/:id/checkout', (req, res) => handleCheckAction(req, res, 'checkout'));
app.get('/api/statistics', async (req, res, next) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const totalToday = await Registration.countDocuments({ createdAt: { $gte: today, $lt: tomorrow } });
        const checkedIn = await Registration.countDocuments({ status: 'Đã vào cổng' });
        const pending = await Registration.countDocuments({ status: { $in: ['Chờ khai báo', 'Đã khai báo'] } });
        const completedToday = await Registration.countDocuments({ status: 'Đã rời cổng', checkOutTime: { $gte: today, $lt: tomorrow } });

        res.status(200).json({ totalToday, checkedIn, pending, completedToday });
    } catch (error) {
        next(error);
    }
});
app.get('/api/registrations/history', async (req, res, next) => {
    try {
        const { start, end, q, priority, type } = req.query;

        if (!start || !end) {
            return res.status(400).json({ message: 'Ngày bắt đầu và kết thúc là bắt buộc.' });
        }

        const startDate = new Date(start);
        startDate.setHours(0, 0, 0, 0);

        const endDate = new Date(end);
        endDate.setHours(23, 59, 59, 999);
        
        const query = {
            createdAt: {
                $gte: startDate,
                $lte: endDate
            }
        };

        if (priority) {
            query.priority = priority;
        }

        if (q) {
            const regex = new RegExp(q, 'i');
            const employees = await Employee.find({ name: regex }).select('_id');
            const suppliers = await Supplier.find({ name: regex }).select('_id');
            const vehicles = await Vehicle.find({ $or: [{ licensePlate: regex }, { driverName: regex }, { vehicleType: regex }] }).select('_id');

            const orConditions = [
                { reason: regex }
            ];
            if (employees.length > 0) orConditions.push({ employee: { $in: employees.map(emp => emp._id) } });
            if (suppliers.length > 0) orConditions.push({ supplier: { $in: suppliers.map(sup => sup._id) } });
            if (vehicles.length > 0) orConditions.push({ vehicle: { $in: vehicles.map(veh => veh._id) } });

            if (orConditions.length > 0) {
                query.$or = orConditions;
            }
        }
        
        if (type) {
             const vehiclesByType = await Vehicle.find({ vehicleType: new RegExp(type, 'i') }).select('_id');
             const vehicleIds = vehiclesByType.map(v => v._id);
             
             if (query.vehicle && query.vehicle.$in) {
                 query.vehicle.$in = [...new Set([...query.vehicle.$in, ...vehicleIds])];
             } else {
                 query.vehicle = { $in: vehicleIds };
             }
        }

        const historyLogs = await Registration.find(query)
            .populate('employee', 'name department')
            .populate('supplier', 'name')
            .populate('vehicle', 'licensePlate driverName vehicleType')
            .sort({ createdAt: -1 });

        res.status(200).json(historyLogs);
    } catch (error) {
        next(error);
    }
});

// Middleware xử lý lỗi tập trung
app.use((err, req, res, next) => {
    console.error(err.stack);
    if (err.code === 11000) {
        return res.status(409).json({ message: 'Dữ liệu bị trùng lặp. Vui lòng kiểm tra lại.' });
    }
    res.status(500).json({ message: 'Lỗi máy chủ nội bộ. Vui lòng thử lại sau.' });
});


// --- 9. KHỞI ĐỘNG SERVER ---
server.listen(port, () => {
    console.log(`🚀 Server đang chạy tại http://localhost:${port}`);
});
