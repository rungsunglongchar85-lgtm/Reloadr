const Razorpay = require('razorpay');
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
export default async function handler(req,res){
  try{
    const {amount}=req.body;
    const order=await razorpay.orders.create({
      amount: Math.round(amount*100),
      currency:'INR',
      receipt:'order_'+Date.now()
    });
    res.status(200).json(order);
  }catch(e){
    res.status(500).json({error:e.message});
  }
     }
